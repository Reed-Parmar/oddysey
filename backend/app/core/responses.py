"""Response envelopes and pagination (api.md §1)."""

from typing import Annotated, Any, Generic, TypeVar

from fastapi import Depends, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

from app.core.errors import AppError

T = TypeVar("T")


class Out(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class In(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Meta(BaseModel):
    warnings: list[str] = []


class PageMeta(BaseModel):
    page: int
    page_size: int
    total: int


class Envelope(BaseModel, Generic[T]):
    data: T
    meta: Meta | None = None


class ListEnvelope(BaseModel, Generic[T]):
    data: list[T]


class PageEnvelope(BaseModel, Generic[T]):
    data: list[T]
    meta: PageMeta


class PageParams:
    def __init__(
        self, page: Annotated[int, Query(ge=1)] = 1, page_size: Annotated[int, Query(ge=1, le=100)] = 20
    ) -> None:
        self.page, self.page_size = page, page_size


Page = Annotated[PageParams, Depends()]


def empty_page(params: PageParams) -> PageEnvelope[Any]:
    return PageEnvelope(data=[], meta=PageMeta(page=params.page, page_size=params.page_size, total=0))


def ok(data: Any, warnings: list[str] | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {"data": data}
    if warnings:
        body["meta"] = {"warnings": warnings}
    return body


def paginate(db: Session, stmt: Select[Any], params: PageParams) -> tuple[list[Any], PageMeta]:
    total = db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery())) or 0
    rows = db.scalars(stmt.limit(params.page_size).offset((params.page - 1) * params.page_size)).unique().all()
    return list(rows), PageMeta(page=params.page, page_size=params.page_size, total=total)


def check_sort(value: str, allowed: set[str]) -> str:
    if value not in allowed:
        raise AppError(
            422,
            "VALIDATION_ERROR",
            "Validation failed",
            [{"field": "query.sort", "message": f"must be one of {sorted(allowed)}"}],
        )
    return value


def clean_q(q: str | None) -> str | None:
    if q is None or not q.strip():
        return None
    q = q.strip()[:100]
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


NonEmpty = Field(min_length=1)
