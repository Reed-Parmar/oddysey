"""Dataset values transcribed from CSR_Hackathon_ITI_Project_Dataset.xlsx.

Only scoring inputs are kept. Names, gender and centre are omitted on purpose.
"""

from spa_ai.scoring import ProjectInput, TraineeInput


def _tid(name: str) -> str:
    return name.lower().replace(" ", "_")


TRAINEES: list[TraineeInput] = [
    TraineeInput('TRN-EL-001', _tid('Electrician'), 'Electrician', 82.0, 88.0, 95.0, ('Circuit Wiring', 'PLC Logic', 'Multimeter'), 'Industrial Automation & Solar', None),
    TraineeInput('TRN-EL-002', _tid('Electrician'), 'Electrician', 91.0, 94.0, 98.0, ('Solar Wiring', 'Microcontrollers', 'IoT'), 'Renewable Energy Systems', None),
    TraineeInput('TRN-FT-003', _tid('Fitter'), 'Fitter', 75.0, 85.0, 90.0, ('Lathe Machine', 'Fitting', 'Vernier Caliper'), 'Precision Mechanical Maintenance', None),
    TraineeInput('TRN-FT-004', _tid('Fitter'), 'Fitter', 68.0, 72.0, 85.0, ('Basic Fitting', 'Drilling', 'Grinding'), 'General Workshop Repair', None),
    TraineeInput('TRN-WD-005', _tid('Welder'), 'Welder', 88.0, 92.0, 96.0, ('TIG Welding', 'MIG Welding', 'Blueprint Reading'), 'Structural Fabrication', None),
    TraineeInput('TRN-WD-006', _tid('Welder'), 'Welder', 79.0, 81.0, 88.0, ('ARC Welding', 'Gas Cutting', 'Joint Prep'), 'Pipe & Sheet Metal Welding', None),
    TraineeInput('TRN-CP-007', _tid('COPA'), 'COPA', 95.0, 96.0, 99.0, ('Python', 'Web Design', 'Excel Automation'), 'IT Helpdesk & Software QA', None),
    TraineeInput('TRN-CP-008', _tid('COPA'), 'COPA', 80.0, 83.0, 91.0, ('HTML/CSS', 'Tally Prime', 'Database Ops'), 'Data Entry & Office Tech', None),
    TraineeInput('TRN-AU-009', _tid('Mechanic Motor Vehicle'), 'Mechanic Motor Vehicle', 84.0, 89.0, 93.0, ('EV Battery Maintenance', 'Engine Overhaul'), 'Electric Vehicle Servicing', None),
    TraineeInput('TRN-AU-010', _tid('Mechanic Motor Vehicle'), 'Mechanic Motor Vehicle', 78.0, 86.0, 90.0, ('Brake Systems', 'ECU Diagnostics'), 'Automotive Diagnostics', None),
    TraineeInput('TRN-SL-011', _tid('Solar Technician'), 'Solar Technician', 89.0, 91.0, 97.0, ('PV Array Installation', 'Inverter Setup'), 'Rooftop Solar EPC', None),
    TraineeInput('TRN-SL-012', _tid('Solar Technician'), 'Solar Technician', 72.0, 78.0, 86.0, ('Solar Wiring', 'Battery Bank Wiring'), 'Solar Pump Maintenance', None),
]

PROJECTS: list[ProjectInput] = [
    ProjectInput('PRJ-EL-101', 'PRJ-EL-101', 'Dual-Axis Automatic Solar Tracking System', 'CSR Green Energy Drive', None, 'advanced', _tid('Electrician'), 'Electrician', 85.0, ('Solar Wiring', 'Circuit Design', 'Microcontrollers')),
    ProjectInput('PRJ-EL-102', 'PRJ-EL-102', 'Smart Home Automation Board with Relay Control', 'CSR Digital Electronics', None, 'intermediate', _tid('Electrician'), 'Electrician', 75.0, ('Circuit Wiring', 'Switches', 'Relay Modules')),
    ProjectInput('PRJ-FT-201', 'PRJ-FT-201', 'Precision Mini Hydraulic Bench Press Model', 'CSR Workshop Innovation', None, 'advanced', _tid('Fitter'), 'Fitter', 80.0, ('Lathe Turning', 'Hydraulic Assembly', 'Fitting')),
    ProjectInput('PRJ-FT-202', 'PRJ-FT-202', 'Modular Metal Storage Cabinet with Lock System', 'CSR Infrastructure Aid', None, 'intermediate', _tid('Fitter'), 'Fitter', 70.0, ('Sheet Metal Cutting', 'Drilling', 'Fitting')),
    ProjectInput('PRJ-WD-301', 'PRJ-WD-301', 'Heavy Duty Tubular Steel Workbench Fabrication', 'CSR Vocational Skill Grant', None, 'intermediate', _tid('Welder'), 'Welder', 75.0, ('TIG/MIG Welding', 'Joint Grinding', 'Blueprint')),
    ProjectInput('PRJ-CP-401', 'PRJ-CP-401', 'CSR Center Student & inventory Management Web Portal', 'CSR Digitalization Initiative', None, 'advanced', _tid('COPA'), 'COPA', 85.0, ('Python', 'HTML/CSS', 'SQLite Database')),
    ProjectInput('PRJ-AU-501', 'PRJ-AU-501', 'EV Battery Management & Diagnostics Test Rig', 'CSR Clean Mobility Mission', None, 'advanced', _tid('Mechanic Motor Vehicle'), 'Mechanic Motor Vehicle', 80.0, ('EV Battery Wiring', 'ECU Scanners', 'Multimeter')),
    ProjectInput('PRJ-SL-601', 'PRJ-SL-601', 'Off-Grid Solar Powered Agri-Pumping Unit', 'CSR Rural Water Innovation', None, 'intermediate', _tid('Solar Technician'), 'Solar Technician', 75.0, ('PV Array Wiring', 'DC Motors', 'Inverters')),
]

CAPACITY: dict[str, int] = {'PRJ-EL-101': 4, 'PRJ-EL-102': 5, 'PRJ-FT-201': 3, 'PRJ-FT-202': 6, 'PRJ-WD-301': 4, 'PRJ-CP-401': 3, 'PRJ-AU-501': 4, 'PRJ-SL-601': 5}
