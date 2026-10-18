"""Generate the demo input PDFs in data/inputs/ (sample resumes and v1/v2 report submissions).

All people, phone numbers and e-mails are fictional (example.com, 90000000xx).
Skills and project titles match data/sample_catalog/project_catalog_demo.csv.

Run from the repo root:
    backend/.venv/Scripts/python.exe data/inputs/make_samples.py
Each PDF is re-read with pypdf to check that it has a text layer.
"""

from __future__ import annotations

from pathlib import Path

from fpdf import FPDF
from pypdf import PdfReader

HERE = Path(__file__).resolve().parent
RESUMES = HERE / "resumes"
SUBMISSIONS = HERE / "submissions"

# ---------------------------------------------------------------- resumes

RESUME_DATA = [
    {
        "file": "resume_copa_sneha_kulkarni.pdf",
        "name": "Sneha Kulkarni",
        "trade": "COPA",
        "email": "sneha.kulkarni@example.com",
        "phone": "+91 9000000055",
        "city": "Thane, Maharashtra",
        "objective": (
            "COPA trainee interested in IT Helpdesk & Software QA. I want to build reliable web tools "
            "for training centres and use Python and Excel automation to reduce repetitive office work."
        ),
        "education": [
            "COPA (Computer Operator and Programming Assistant), Tata STRIVE SDC - Thane - 2026",
            "Demo assessment: Trade Theory 95%, Workshop Practical 96%, Safety Compliance 99%",
        ],
        "skills": [
            "Python scripting and CSV processing",
            "Web Design with HTML/CSS and accessible forms",
            "SQLite Database: tables, queries and parameterised SQL",
            "Excel Automation: formulas, validation and reporting",
            "Software QA: test cases, defect reports and regression checks",
        ],
        "training": [
            "Built a practice student register using Python, HTML/CSS and SQLite with input validation.",
            "Automated an Excel stock summary and reconciled totals against source records.",
            "Wrote test cases for duplicate records, missing fields and invalid stock quantities.",
        ],
        "interest": "IT Helpdesk & Software QA; student and inventory management tools for CSR centres.",
    },
    {
        "file": "resume_electrician_ravi_kumar.pdf",
        "name": "Ravi Kumar Patel",
        "trade": "Electrician",
        "email": "ravi.patel@example.com",
        "phone": "+91 9000000011",
        "city": "Anand, Gujarat",
        "objective": (
            "ITI Electrician trainee who enjoys house wiring and panel work. I want to work on real "
            "community projects where I can wire, test and hand over safe electrical installations, "
            "and later become a licensed wireman."
        ),
        "education": [
            "ITI Electrician (NCVT), Government ITI Anand - 2025 to 2027 (2nd year)",
            "SSC (Class 10), Gujarat Board - 2025",
        ],
        "skills": [
            "Electrical Wiring (casing-capping and conduit)",
            "Switchboard Installation",
            "Electrical Safety (lockout, earthing checks, PPE)",
            "Multimeter and megger use",
            "Reading Electrical Diagrams",
            "MCB / RCCB selection",
        ],
        "training": [
            "Wired a 2BHK demo house layout in the ITI workshop: 6 light points, 3 fans, 5 sockets, one DB with MCBs.",
            "Assisted a local contractor for 3 weeks of summer work replacing old switchboards in a housing society.",
            "Tested earth resistance of the workshop earth pit with the instructor and recorded readings.",
        ],
        "interest": "Domestic and commercial wiring, switchboard installation, teaching wiring to others.",
    },
    {
        "file": "resume_solar_technician_meena_sharma.pdf",
        "name": "Meena Sharma",
        "trade": "Solar Technician",
        "email": "meena.sharma@example.com",
        "phone": "+91 9000000022",
        "city": "Nashik, Maharashtra",
        "objective": (
            "Solar Technician (Electrical) trainee. I want to maintain and repair solar systems in villages "
            "and schools so that the lights keep working after the installer leaves."
        ),
        "education": [
            "ITI Solar Technician (Electrical) (NCVT), Government ITI Nashik - 2025 to 2026",
            "HSC (Class 12, Science), Maharashtra Board - 2025",
        ],
        "skills": [
            "Solar Panel Maintenance (cleaning, inspection, hot-spot check)",
            "Battery Bank Wiring (series / parallel, 12 V and 24 V)",
            "Multimeter (Voc, Isc, battery voltage)",
            "Electrical Safety",
            "Charge controller setup",
        ],
        "training": [
            "Installed a 1 kW off-grid demo system on the ITI roof with my batch (4 panels, 2 batteries, PWM controller).",
            "Cleaned and tested 12 street-light panels in our village with the gram panchayat electrician.",
            "Logged daily battery voltage for 30 days for the workshop solar inverter.",
        ],
        "interest": "Solar maintenance for rural schools and street lights; off-grid systems.",
    },
    {
        "file": "resume_fitter_arjun_desai.pdf",
        "name": "Arjun Desai",
        "trade": "Fitter",
        "email": "arjun.desai@example.com",
        "phone": "+91 9000000033",
        "city": "Vadodara, Gujarat",
        "objective": (
            "ITI Fitter trainee who likes precise hand work. I want to restore and calibrate workshop tools "
            "and learn maintenance fitting in a manufacturing plant."
        ),
        "education": [
            "ITI Fitter (NCVT), Government ITI Vadodara - 2025 to 2027 (2nd year)",
            "SSC (Class 10), Gujarat Board - 2025",
        ],
        "skills": [
            "Basic Fitting (marking, sawing, chipping)",
            "Filing (flat and square to +/- 0.05 mm)",
            "Vernier Caliper and micrometer",
            "Drilling and tapping",
            "Workshop Safety",
        ],
        "training": [
            "Made a T-fit and a dovetail job within 0.05 mm tolerance in the 1st-year trade practical.",
            "Overhauled two pedestal drilling machines with the workshop instructor (belt, spindle, lubrication).",
            "Kept the tool-room measurement register for one semester.",
        ],
        "interest": "Tool restoration, precision measurement and machine maintenance.",
    },
    {
        "file": "resume_welder_imran_shaikh.pdf",
        "name": "Imran Shaikh",
        "trade": "Welder",
        "email": "imran.shaikh@example.com",
        "phone": "+91 9000000044",
        "city": "Pune, Maharashtra",
        "objective": (
            "ITI Welder (Gas and Electric) trainee. I want to fabricate strong, safe steel structures and "
            "trolleys for workshops and later qualify as a certified welder."
        ),
        "education": [
            "ITI Welder (Gas and Electric) (NCVT), Government ITI Pune - 2025 to 2026",
            "SSC (Class 10), Maharashtra Board - 2024",
        ],
        "skills": [
            "ARC Welding (SMAW, flat and horizontal butt and fillet joints)",
            "Gas Cutting (oxy-acetylene)",
            "Welding Safety (PPE, fire watch, cylinder handling)",
            "Reading fabrication drawings",
            "Grinding and finishing",
        ],
        "training": [
            "Fabricated a steel shoe rack and a tool stand from 25 mm square tube in the ITI workshop.",
            "Cut and welded 40 mm angle frames for the ITI notice boards (12 frames).",
            "Two weeks of on-site practice at a local fabrication shop on gate and grill work.",
        ],
        "interest": "Structural fabrication, workshop trolleys and safe material handling equipment.",
    },
]


class Doc(FPDF):
    def __init__(self, footer_text: str):
        super().__init__(format="A4")
        self.footer_text = footer_text
        self.set_auto_page_break(auto=True, margin=18)
        self.set_margins(18, 16, 18)

    def footer(self):
        self.set_y(-12)
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(120)
        self.cell(0, 6, f"{self.footer_text} - page {self.page_no()}", align="C")
        self.set_text_color(0)

    def heading(self, text: str):
        self.ln(2)
        self.set_font("Helvetica", "B", 12)
        self.set_text_color(20, 60, 120)
        self.cell(0, 7, text, new_x="LMARGIN", new_y="NEXT")
        self.set_draw_color(20, 60, 120)
        self.line(self.l_margin, self.get_y(), self.w - self.r_margin, self.get_y())
        self.set_text_color(0)
        self.ln(1.5)

    def para(self, text: str):
        self.set_font("Helvetica", "", 10.5)
        self.multi_cell(0, 5.4, text, new_x="LMARGIN", new_y="NEXT")
        self.ln(1)

    def bullets(self, items: list[str]):
        self.set_font("Helvetica", "", 10.5)
        for item in items:
            self.set_x(self.l_margin + 3)
            self.multi_cell(0, 5.4, f"- {item}", new_x="LMARGIN", new_y="NEXT")
        self.ln(1)


def make_resume(r: dict) -> Path:
    pdf = Doc("Sample resume - fictional person for demo use")
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 18)
    pdf.cell(0, 9, r["name"], new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 11)
    pdf.cell(0, 6, f"ITI Trainee - {r['trade']}", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 9.5)
    pdf.set_text_color(80)
    pdf.cell(0, 5, f"Email: {r['email']}   |   Phone: {r['phone']}   |   {r['city']}", new_x="LMARGIN", new_y="NEXT")
    pdf.set_text_color(0)
    pdf.heading("Career Objective")
    pdf.para(r["objective"])
    pdf.heading("Education")
    pdf.bullets(r["education"])
    pdf.heading("Skills")
    pdf.bullets(r["skills"])
    pdf.heading("Practical Training")
    pdf.bullets(r["training"])
    pdf.heading("Career Interest")
    pdf.para(r["interest"])
    pdf.heading("Languages")
    pdf.para("Hindi, Gujarati / Marathi, basic English.")
    out = RESUMES / r["file"]
    pdf.output(str(out))
    return out


# ---------------------------------------------------------------- report submissions

SUBMISSION_DATA = [
    {
        "file": "sneha_kulkarni_csr_portal_v1.pdf",
        "project": "CSR Center Student & inventory Management Web Portal",
        "trainee": "Sneha Kulkarni (COPA, TRN-CP-007)",
        "version": "Version 1 - first draft",
        "sections": [
            ("Aim", ["To make a web portal for student records and inventory at the CSR centre."]),
            ("Work done", [
                "I made student and inventory forms using Python, HTML/CSS and SQLite. "
                "I added a few sample records and displayed them in tables. The pages open in the browser.",
            ]),
            ("Conclusion", ["The basic portal works. More testing and documentation are needed."]),
        ],
    },
    {
        "file": "sneha_kulkarni_csr_portal_v2.pdf",
        "project": "CSR Center Student & inventory Management Web Portal",
        "trainee": "Sneha Kulkarni (COPA, TRN-CP-007)",
        "version": "Version 2 - resubmission after rework",
        "sections": [
            ("Aim and Scope", [
                "Build a local demonstration portal for CSR centre staff to maintain student records, "
                "record inventory receipts and issues, and export stock summaries. Project reference: PRJ-CP-401. "
                "All records and results in this report are fictional demo evidence.",
            ]),
            ("Materials and Tools", [
                "One training-centre computer, Python 3, HTML/CSS, SQLite, a browser and a code editor. "
                "Used Python csv and sqlite3 modules for exports and storage; no paid software was required.",
            ]),
            ("Design and Procedure", [
                "1. Defined student fields (code, name, trade, centre) and item fields (code, name, unit). "
                "Stored receipts and issues as transactions with quantity, date and reason.",
                "2. Created SQLite tables with unique student/item codes and foreign keys. "
                "Used parameterised SQL and a transaction for each stock issue.",
                "3. Built labelled HTML/CSS forms, search results and validation messages. "
                "Rejected blank required fields, duplicate codes and non-positive quantities.",
                "4. Calculated available stock from receipts minus issues. Blocked an issue exceeding "
                "available stock and exported the stock summary as CSV for Excel.",
                "5. Added staff sign-in, checked access on protected pages, and documented a "
                "database backup and restore exercise using synthetic records only.",
            ]),
            ("Safety and Data Protection", [
                "Used fictional names and contact details; kept the SQLite file outside the public directory. "
                "Stored password hashes, kept credentials out of the report, and signed out on shared computers.",
                "Limited write access to authorised staff. Kept a backup before changes and used "
                "safe posture and regular screen breaks during computer work.",
            ]),
            ("Test Cases and Observations", [
                "Demo test set: 20 fictional students, 15 inventory items and 30 stock transactions. "
                "Ran 12 checks: 4 student validation, 4 stock validation, 2 access and 2 export/restore checks.",
                "First pass: 10/12 checks passed. Fixed acceptance of a negative issue quantity and a "
                "missing duplicate-code message. Re-ran all 12 checks: 12/12 passed in the demo scenario.",
                "Stock reconciliation example: opening quantity 10 keyboards + receipt 5 - issue 3 = "
                "12 available. An attempted issue of 13 was rejected and the balance stayed at 12.",
                "Restored the backup into a separate database and checked all 20 student records and "
                "15 item balances against the original. CSV row counts and stock totals matched.",
            ]),
            ("Results and Limitations", [
                "Delivered working student forms, inventory transactions, stock CSV export, a test checklist "
                "and a short staff guide in this fictional exercise. The prototype was tested locally; "
                "multi-user load, production hosting and independent security review remain future work.",
            ]),
            ("Logbook and Bill of Materials", [
                "24 hours over 4 days: requirements and schema 4 h; forms and database 8 h; "
                "validation and testing 8 h; documentation and handover 4 h.",
                "BOM: existing centre computer and internet, Python, SQLite and editor: "
                "Rs. 0 additional procurement. Hardware and connectivity were provided by the centre.",
            ]),
            ("Conclusion", [
                "The exercise connected Python, Web Design and Excel Automation with Software QA. "
                "Validation and stock reconciliation made the demonstration more reliable. "
                "Next steps are role-based access review and testing simultaneous stock updates.",
            ]),
        ],
    },
    {
        "file": "solar_street_light_v1.pdf",
        "project": "Solar Street Light Maintenance Drive for a Rural School",
        "trainee": "Meena Sharma (Solar Technician)",
        "version": "Version 1 - first draft",
        "sections": [
            ("Aim", [
                "To repair the solar street lights at the school.",
            ]),
            ("What I did", [
                "I went to the school with my group. There were some street lights that were not working. "
                "We cleaned the panels and checked the batteries. Some wires were loose so we tightened them. "
                "After that most of the lights were working.",
                "We also told the school peon to clean the panels sometimes.",
            ]),
            ("Conclusion", [
                "The work was done and the lights are better now. I learned about solar lights.",
            ]),
        ],
    },
    {
        "file": "solar_street_light_v2.pdf",
        "project": "Solar Street Light Maintenance Drive for a Rural School",
        "trainee": "Meena Sharma (Solar Technician)",
        "version": "Version 2 - resubmission after rework",
        "sections": [
            ("Aim", [
                "To inspect, clean and repair the 10 solar street lights around the Government Primary School, "
                "rewire faulty battery banks, record before and after readings and hand over a maintenance logbook "
                "and safety checklist to the school.",
            ]),
            ("Materials and Tools", [
                "Digital multimeter (DC 0-600 V, 10 A), clamp meter, insulated screwdriver set, wire stripper, crimping tool.",
                "4 sq mm copper battery cable (6 m), ring lugs (20), heat-shrink sleeves, petroleum jelly for terminals.",
                "Soft brush, bucket, clean water, microfibre cloth, 6 ft fibreglass ladder.",
                "PPE: insulated gloves, safety goggles, safety shoes, helmet.",
            ]),
            ("Procedure", [
                "1. Made a list of all 10 poles (P1-P10) and noted which lights did not glow at night (P2, P5, P7, P9).",
                "2. Switched off each light at the charge controller and covered the panel before touching any wiring.",
                "3. Cleaned every panel with water and a soft brush in the early morning when the panels were cool.",
                "4. Measured open-circuit voltage (Voc) and short-circuit current (Isc) of each panel at noon.",
                "5. Measured battery voltage at rest. Found corroded terminals on P2 and P7 and a broken lug on P5.",
                "6. Cut back the corroded cable, fitted new ring lugs, tightened terminals and applied petroleum jelly.",
                "7. Replaced the cracked battery-to-controller cable on P9 with new 4 sq mm cable.",
                "8. Checked the dusk sensor and the LED driver on each pole, then switched on and tested at 7 pm.",
            ]),
            ("Safety Precautions", [
                "Panel covered and controller switched off before working on battery wiring; battery negative removed first.",
                "Insulated gloves and goggles worn when handling battery terminals (acid and short-circuit risk).",
                "Ladder footed by a second trainee at all times; no work at height when wind was strong.",
                "No metal watch or ring; tools kept insulated; a fire extinguisher kept near the battery box.",
            ]),
            ("Observations and Results", [
                "Average panel Voc before cleaning: 19.1 V; after cleaning: 21.4 V (rated 22.0 V).",
                "Average panel Isc before cleaning: 2.1 A; after cleaning: 2.8 A (about 33% more current).",
                "Battery rest voltage on P2 rose from 11.2 V to 12.6 V after one sunny day of charging.",
                "Lights working: before 6 of 10, after 10 of 10. All 10 lights stayed on for at least 10 hours on the test night.",
            ]),
            ("Conclusion", [
                "Dust and corroded battery terminals were the main reasons the lights failed. After cleaning and rewiring, "
                "all 10 lights work and panel current improved by about one third. I learned to read panel and battery "
                "values properly and to isolate the system before working. Monthly cleaning is needed in the dry season.",
            ]),
            ("Logbook and Bill of Materials", [
                "Logbook: 18 hours over 3 days (day 1 survey and cleaning 6 h, day 2 rewiring 7 h, day 3 testing and handover 5 h).",
                "BOM: 4 sq mm cable 6 m Rs. 420, ring lugs 20 nos Rs. 160, heat-shrink Rs. 80, petroleum jelly Rs. 60. Total Rs. 720.",
                "A maintenance logbook and a safety checklist were handed over to the school headmaster.",
            ]),
        ],
    },
    {
        "file": "domestic_wiring_board_v1.pdf",
        "project": "Domestic Wiring Demonstration Board for a Village Skill Centre",
        "trainee": "Ravi Kumar Patel (Electrician)",
        "version": "Version 1 - first draft",
        "sections": [
            ("Aim", [
                "To make a wiring board for the skill centre.",
            ]),
            ("Work done", [
                "I made a board with a light, a fan and a socket. I used wires and switches and an MCB. "
                "I fixed everything on a plywood board and connected it. It is working.",
                "The board will be used to teach village youth.",
            ]),
            ("Conclusion", [
                "The board is ready. It was a good project.",
            ]),
        ],
    },
    {
        "file": "domestic_wiring_board_v2.pdf",
        "project": "Domestic Wiring Demonstration Board for a Village Skill Centre",
        "trainee": "Ravi Kumar Patel (Electrician)",
        "version": "Version 2 - resubmission after rework",
        "sections": [
            ("Aim", [
                "To build a wall-mounted demonstration board showing a lighting circuit, a fan circuit with regulator and "
                "a 6 A / 16 A socket circuit, each protected by its own MCB, together with a wiring diagram and a safety "
                "checklist, so that village youth at the skill centre can learn safe domestic wiring.",
            ]),
            ("Materials and Tools", [
                "18 mm plywood board 4 ft x 3 ft, PVC casing-capping 20 mm (8 m), 4-way SPN distribution board.",
                "MCBs: 1 x 32 A DP main, 2 x 6 A SP (light, fan), 1 x 16 A SP (power socket); 30 mA RCCB 25 A.",
                "1.5 sq mm and 2.5 sq mm FR copper wire (red, black, green), 2 x 6 A switches, 1 x 16 A switch, "
                "1 x 6 A socket, 1 x 16 A socket, fan regulator, LED batten, 2-way switch pair.",
                "Tools: combination plier, wire stripper, screwdriver set, drill machine, multimeter, 500 V insulation tester.",
            ]),
            ("Procedure", [
                "1. Drew the layout and single-line diagram on paper and got it checked by the instructor.",
                "2. Marked and fixed the casing-capping, switchboards and DB on the plywood with screws every 30 cm.",
                "3. Ran 1.5 sq mm wire for light and fan circuits and 2.5 sq mm for the 16 A socket circuit.",
                "4. Wired the 2-way staircase light circuit, the fan through the regulator, and both sockets with earth.",
                "5. Connected each circuit to its own MCB in the DB, through the RCCB and the main MCB.",
                "6. Did a continuity test of every circuit and a polarity test so that switches break the phase wire.",
                "7. Did an insulation resistance test at 500 V between phase-neutral, phase-earth and neutral-earth.",
                "8. Powered the board from a 3-pin top with a 16 A plug only after the instructor checked it.",
            ]),
            ("Safety Precautions", [
                "Board never connected to supply during wiring; supply plug kept with the instructor until final test.",
                "Correct colour code used: red phase, black neutral, green earth; all metal parts earthed.",
                "RCCB tested with its test button; MCB ratings chosen for wire size (6 A on 1.5 sq mm, 16 A on 2.5 sq mm).",
                "No bare conductor outside terminals; all screws tightened; insulated tools and rubber mat used.",
                "A printed safety checklist (8 points) is fixed on the board for learners.",
            ]),
            ("Observations and Results", [
                "Insulation resistance: phase-earth 120 megohm, neutral-earth 95 megohm, phase-neutral 150 megohm (minimum 1 megohm).",
                "Supply voltage 231 V. LED batten current 0.09 A; fan at full speed 0.31 A; 16 A socket with 1 kW heater 4.3 A.",
                "RCCB tripped in under 0.1 s when the test button was pressed (3 trials).",
                "All 5 circuits worked first time after testing; the 2-way switch works from both ends.",
            ]),
            ("Conclusion", [
                "The demonstration board is complete, tested and safe. It shows lighting, fan and socket circuits with MCB and "
                "RCCB protection exactly as in a real house. Doing the insulation and polarity tests showed me why every "
                "installation must be tested before it is energised. The diagram and checklist will help the centre teach.",
            ]),
            ("Logbook and Bill of Materials", [
                "Logbook: 22 hours over 4 days (planning and diagram 4 h, fixing 6 h, wiring 8 h, testing and handover 4 h).",
                "BOM: plywood Rs. 1,150, casing-capping Rs. 240, DB Rs. 450, MCBs and RCCB Rs. 1,900, wires Rs. 780, "
                "switches, sockets, regulator and batten Rs. 1,050. Total Rs. 5,570.",
                "The wiring diagram (A3) and the safety checklist were handed over with the board.",
            ]),
        ],
    },
]


def make_submission(s: dict) -> Path:
    pdf = Doc(f"Sample project report - {s['version']} - fictional trainee for demo use")
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 15)
    pdf.multi_cell(0, 7.5, f"Project Report: {s['project']}", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(80)
    pdf.cell(0, 5.5, f"Trainee: {s['trainee']}   |   {s['version']}", new_x="LMARGIN", new_y="NEXT")
    pdf.set_text_color(0)
    for title, paras in s["sections"]:
        pdf.heading(title)
        for p in paras:
            pdf.para(p)
    out = SUBMISSIONS / s["file"]
    pdf.output(str(out))
    return out


def check_text(path: Path, must_contain: str) -> int:
    reader = PdfReader(str(path))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    if must_contain not in text:
        raise SystemExit(f"{path.name}: text layer missing or incomplete (expected {must_contain!r})")
    return len(reader.pages)


def main() -> None:
    RESUMES.mkdir(parents=True, exist_ok=True)
    SUBMISSIONS.mkdir(parents=True, exist_ok=True)
    for r in RESUME_DATA:
        out = make_resume(r)
        pages = check_text(out, r["name"])
        print(f"ok  {out.relative_to(HERE)}  ({pages} page(s), text layer verified)")
    for s in SUBMISSION_DATA:
        out = make_submission(s)
        pages = check_text(out, s["sections"][0][0])
        print(f"ok  {out.relative_to(HERE)}  ({pages} page(s), text layer verified)")


if __name__ == "__main__":
    main()
