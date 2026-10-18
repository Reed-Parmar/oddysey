"""IMP-04 (ADR-031): bulk-create trainee records and their login accounts, keyed by phone number.

Same mechanics as IMP-01 (imports.py): XLSX/CSV, dry run by default, every row validated inside one transaction that is
rolled back for a dry run or when any row fails. On apply, a confirmed Supabase user is created per new phone through
the Admin API (login email derived from the phone) with the shared initial password from TRAINEE_DEFAULT_PASSWORD,
then app.users (student, must_change_password) and trainees.user_id are written. The password is never returned,
logged or audited. Phones are never logged or put in audit metadata.
"""

import re
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, File, Form, UploadFile
from pydantic import BaseModel
from sqlalchemy import func, select

from app import audit, auth_admin, jobs
from app.automation.onboarding import generate_trainee_code
from app.core.config import get_settings
from app.core.deps import DB, Admin
from app.core.responses import Envelope
from app.db import models as M
from app.db.enums import CycleStatus, UserRole, UserStatus
from app.domain import clean_names, resolve_trade_names, set_trainee_trades
from app.modules.imports import (
    ImportResult,
    RowCollector,
    _cycle,
    _decimal,
    _finish,
    _read,
    _split,
    _text,
    parse_upload,
    same_trades,
)

router = APIRouter(tags=["imports"])

ACCOUNT_REQUIRED = ["Phone Number", "Full Name", "ITI Trade"]
SCORE_COLUMNS = (
    ("Trade Theory Score (%)", "theory_score"),
    ("Workshop Practical Score (%)", "practical_score"),
    ("Safety Compliance Score (%)", "safety_score"),
)
_MOBILE = re.compile(r"^[6-9][0-9]{9}$")
_SEPARATORS = re.compile(r"[\s\-().]")


def normalise_phone(raw: Any) -> str | None:
    """A 10-digit Indian mobile → `+91XXXXXXXXXX`. Accepts spaces, dashes, brackets and a +91 / 91 / 0 prefix."""
    s = _text(raw)
    if not s:
        return None
    digits = _SEPARATORS.sub("", s)
    if digits.startswith("+"):
        if not digits.startswith("+91"):
            return None
        digits = digits[3:]
    elif len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    return "+91" + digits if _MOBILE.match(digits) else None


def login_email(phone: str) -> str:
    """The deterministic login email for a normalised phone (the SPA derives the same one at login)."""
    return f"{phone.lstrip('+')}@{get_settings().trainee_login_email_domain}".lower()


class AccountRowResult(BaseModel):
    row: int
    phone: str
    full_name: str
    trainee_code: str | None  # null in a dry run for a trainee that would be created
    trainee: Literal["created", "updated", "unchanged"]
    account: Literal["created", "linked", "existing"]


class TraineeAccountImportResult(ImportResult):
    accounts_created: int
    accounts_linked: int
    accounts_existing: int
    results: list[AccountRowResult]


@router.post("/admin/imports/trainee-accounts")
async def import_trainee_accounts(
    admin: Admin,
    db: DB,
    file: Annotated[UploadFile, File()],
    cycle_id: Annotated[str, Form()],
    dry_run: Annotated[bool, Form()] = True,
) -> Envelope[TraineeAccountImportResult]:
    data = await _read(file)
    sheet = parse_upload(file.filename or "", data, "Trainee Accounts", "Phone Number", ACCOUNT_REQUIRED)
    cycle = _cycle(db, cycle_id)
    rc = RowCollector(sheet)
    result = TraineeAccountImportResult(
        applied=False,
        rows=len(sheet.rows),
        created=0,
        updated=0,
        unchanged=0,
        created_trades=[],
        created_skills=[],
        warnings=[],
        errors=[],
        accounts_created=0,
        accounts_linked=0,
        accounts_existing=0,
        results=[],
    )

    def finish() -> Envelope[TraineeAccountImportResult]:
        result.errors = rc.errors
        if result.errors or dry_run:
            _finish(db, result, dry_run, admin, "import.trainee_accounts", cycle)  # rolls back (and raises on apply)
            return Envelope(data=result)
        audit.record(  # counts only: never phones, names or the password
            db,
            admin.id,
            "import.trainee_accounts",
            "cycle",
            cycle.id,
            {
                "rows": result.rows,
                "created": result.created,
                "updated": result.updated,
                "accounts_created": result.accounts_created,
                "accounts_linked": result.accounts_linked,
                "accounts_existing": result.accounts_existing,
            },
        )
        db.commit()
        result.applied = True
        return Envelope(data=result)

    if rc.errors:
        return finish()

    has = {key: col.lower() in sheet.headers for col, key in SCORE_COLUMNS}
    has_centre = "iti name" in sheet.headers
    has_interest = "primary career interest" in sheet.headers

    seen: set[str] = set()
    parsed: list[dict[str, Any]] = []
    for number, r in sheet.rows:
        before = len(rc.errors)
        phone = normalise_phone(r.get("phone number"))
        if phone is None:
            rc.err(number, "Phone Number", "required: a 10-digit Indian mobile number (optionally with +91)")
        elif phone in seen:
            rc.err(number, "Phone Number", "this phone number appears more than once in the file")
        else:
            seen.add(phone)
        name = _text(r.get("full name"))
        if not name or len(name) > 120:
            rc.err(number, "Full Name", "required (1–120 characters)")
        trades_raw = _split(r.get("iti trade"))
        if not trades_raw or len(trades_raw) > 5 or any(len(x) > 80 for x in trades_raw):
            rc.err(number, "ITI Trade", "required: 1–5 trades separated by commas (each up to 80 characters)")
        values: dict[str, Any] = {"full_name": name, "phone": phone}
        if has_centre:
            centre = _text(r.get("iti name"))
            if centre and len(centre) > 120:
                rc.err(number, "ITI Name", "at most 120 characters")
            values["centre_name"] = centre
        for col, key in SCORE_COLUMNS:
            if not has[key]:
                continue
            try:
                v: Decimal | None = _decimal(r.get(col.lower()))
                if v is not None and not (0 <= v <= 100):
                    raise ValueError("must be 0–100")
                values[key] = v
            except ValueError as e:
                rc.err(number, col, str(e))
        if has_interest:
            interest = _text(r.get("primary career interest"))
            if interest and len(interest) > 300:
                rc.err(number, "Primary Career Interest", "at most 300 characters")
            values["career_interest"] = interest
        if len(rc.errors) == before:
            trades = clean_names(trades_raw, 5, "ITI Trade")
            parsed.append({"row": number, "values": values, "trades": trades})
    if rc.errors:
        return finish()

    # ---- current state (locked for the duration of the request)
    phones = [p["values"]["phone"] for p in parsed]
    emails = {ph: login_email(ph) for ph in phones}
    users = {
        u.email.lower(): u
        for u in db.scalars(select(M.User).where(func.lower(M.User.email).in_(list(emails.values()))))
    }
    existing = {
        t.phone: t
        for t in db.scalars(
            select(M.Trainee)
            .where(M.Trainee.cycle_id == cycle.id, M.Trainee.phone.in_(phones))
            .with_for_update(of=M.Trainee)
        )
    }
    open_links = {
        t.user_id: t
        for t in db.scalars(
            select(M.Trainee)
            .join(M.Cycle, M.Cycle.id == M.Trainee.cycle_id)
            .where(M.Trainee.user_id.in_([u.id for u in users.values()]), M.Cycle.status != CycleStatus.archived)
        )
    }
    earlier_codes: dict[str, str] = {}
    for ph, code in db.execute(
        select(M.Trainee.phone, M.Trainee.trainee_code)
        .where(M.Trainee.phone.in_(phones), M.Trainee.cycle_id != cycle.id)
        .order_by(M.Trainee.created_at)
    ):
        earlier_codes[ph] = code  # latest wins: the same person keeps one code across cycles (ADR-024 exclusions)

    plans: list[tuple[dict[str, Any], M.Trainee | None, M.User | None]] = []
    for p in parsed:
        number, phone = p["row"], p["values"]["phone"]
        t, u = existing.get(phone), users.get(emails[phone])
        before = len(rc.errors)
        if u is not None and u.role != UserRole.student:
            rc.err(number, "Phone Number", "this phone number's login belongs to a staff account")
        elif t is not None and t.user_id is not None and (u is None or t.user_id != u.id):
            rc.err(number, "Phone Number", "this trainee is already linked to a different login account")
        elif u is not None and (link := open_links.get(u.id)) is not None and (t is None or link.id != t.id):
            where = "this cycle" if link.cycle_id == cycle.id else "another open cycle"
            rc.err(number, "Phone Number", f"this phone number's account already belongs to a trainee in {where}")
        if len(rc.errors) == before:
            plans.append((p, t, u))
    if rc.errors:
        return finish()

    trades, result.created_trades = resolve_trade_names(
        db, sorted({n for p in parsed for n in p["trades"]}, key=str.lower), True
    )
    settings = get_settings()
    admin_api = auth_admin.get_auth_admin() if not dry_run else None
    cycle_codes = {c.upper() for c in db.scalars(select(M.Trainee.trainee_code).where(M.Trainee.cycle_id == cycle.id))}
    for p, t, u in plans:
        values, row_trades = p["values"], [trades[n.lower()] for n in p["trades"]]
        phone = values["phone"]
        if u is None:
            account = "created"
            result.accounts_created += 1
            if admin_api is not None:
                uid = admin_api.ensure_user(emails[phone], settings.trainee_default_password, values["full_name"])
                u = db.get(M.User, uid)
                if u is None:
                    u = M.User(
                        id=uid,
                        email=emails[phone],
                        full_name=values["full_name"],
                        role=UserRole.student,
                        status=UserStatus.active,
                        must_change_password=True,
                    )
                    db.add(u)
                    db.flush()
                audit.record(db, admin.id, "user.created_directly", "user", uid, {"via": "IMP-04", "role": "student"})
        elif t is not None and t.user_id == u.id:
            account = "existing"
            result.accounts_existing += 1
        else:
            account = "linked"
            result.accounts_linked += 1
        if u is not None and u.status == UserStatus.disabled:
            result.warnings.append(f"Row {p['row']}: the login account is disabled; it was not re-enabled")
        if t is None:
            code = earlier_codes.get(phone)
            if code is None or code.upper() in cycle_codes:
                code = generate_trainee_code(db)
            cycle_codes.add(code.upper())
            t = M.Trainee(
                cycle_id=cycle.id,
                trainee_code=code,
                onboarded_via="import",
                user_id=u.id if u is not None else None,
                **values,
            )
            set_trainee_trades(t, row_trades)
            t.skills = []
            db.add(t)
            db.flush()
            result.created += 1
            status = "created"
            shown_code = None if dry_run else t.trainee_code
        else:
            relink = account != "existing"  # in a dry run a new account is not created yet, but would be linked
            dirty = relink or any(getattr(t, k) != v for k, v in values.items())
            dirty = dirty or not same_trades(t.trade_id, t.all_trades, row_trades)
            if dirty:
                for k, v in values.items():
                    setattr(t, k, v)
                set_trainee_trades(t, row_trades)
                if u is not None:
                    t.user_id = u.id
                result.updated += 1
                status = "updated"
            else:
                result.unchanged += 1
                status = "unchanged"
            shown_code = t.trainee_code
        result.results.append(
            AccountRowResult(
                row=p["row"],
                phone=phone,
                full_name=values["full_name"],
                trainee_code=shown_code,
                trainee=status,
                account=account,
            )
        )
    db.flush()
    jobs.enqueue(
        db,
        "allocate_cycle",
        {"cycle_id": str(cycle.id), "trigger": "import"},
        dedupe_key=f"allocate:{cycle.id}",
        trigger="import",
    )
    return finish()
