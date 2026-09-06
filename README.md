# Grade Calculator

A **desktop application** for Windows and macOS. Download the installer, install it, and open Grade Calculator in its own window with a blank gradebook.

## Download

Use the [Releases](https://github.com/WinstonBaker/grade-calculator/releases/latest) page:

- **Windows:** [GradeCaculatorWindowsInstaller.exe](https://github.com/WinstonBaker/grade-calculator/releases/latest/download/GradeCaculatorWindowsInstaller.exe) — download and run the installer. It installs **Grade Calculator.exe** inside a **Grade Calculator** folder and creates a desktop shortcut. If Windows shows SmartScreen, choose **More info → Run anyway**.
- **macOS:** [GradeCalculator-macOS.dmg](https://github.com/WinstonBaker/grade-calculator/releases/latest/download/GradeCalculator-macOS.dmg) — open the disk image and run **Grade Calculator.pkg**. It installs **Grade Calculator.app** inside an **Applications/Grade Calculator** folder and creates a desktop shortcut.

A new install has no classes and no grades. Everything you enter stays on that computer. Later versions are installed from **Settings → Update**.

Version 2.0 is built on the v1.4 clean-install data baseline. Data from older program versions is intentionally not imported. Version 2.0 and later use a versioned, forward-only migration path so future releases can preserve class data without reviving pre-1.4 compatibility code.

## Run from source

```bash
chmod +x run.sh
./run.sh
```

Then open [http://127.0.0.1:5173](http://127.0.0.1:5173). The API is at [http://127.0.0.1:8000](http://127.0.0.1:8000).

Or start the two processes yourself from the repo root:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
```

```bash
cd frontend
npm install
npm run dev
```

All user data, including gradebook names/order, memberships, appearance preferences, grades, and settings, is stored in `grades-v1.db` (gitignored during development). While developing it lives in `data/grades-v1.db`; packaged apps store it in Application Support (Mac) or AppData (Windows). Future releases must keep this database path stable and add numbered migrations for schema changes.

## Features

- **Semesters** — Fall / Spring / Summer, newest first, include/exclude from GPA
- **Classes** — search and sort by code, percent, letter, GPA, credits, or score
- **Gradebook** — category weights, drop lowest, points ratio (`19/20` or `19,50`), bonus, per-item weights, final replaces lowest test, custom cutoffs, GP override
- **Grade scales** — save multiple named defaults (NCSU, UNC, Clemson, ECU, UNCW, UNCC, Duke, College of Charleston, or custom). New classes copy the primary default; each class can apply Default 1, Default 2, or a custom scale
- **What-if** — score needed on remaining work for each letter on the scale
- **GPA dashboard** — term GPA, overall GPA/score, credits remaining, distribution, future-course guess, fumbles
- **Updates** — Settings includes a button that checks GitHub for a newer Windows or Mac build

Scores can be entered as a percent (`95`) or earned/possible (`19/20` or `19,20`).

## License

MIT — see [LICENSE](LICENSE).
