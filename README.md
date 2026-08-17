# Grade Calculator

A **desktop application** for Windows and macOS. Download it, double-click, and it opens in its own window with a blank gradebook.

## Download

Use the [Releases](https://github.com/WinstonBaker/grade-calculator/releases/latest) page:

- **Windows:** [GradeCalculator-Windows.exe](https://github.com/WinstonBaker/grade-calculator/releases/latest/download/GradeCalculator-Windows.exe) — download and open. If Windows shows SmartScreen, choose **More info → Run anyway**.
- **macOS:** [GradeCalculator-macOS.dmg](https://github.com/WinstonBaker/grade-calculator/releases/latest/download/GradeCalculator-macOS.dmg) — open the disk image, drag **Grade Calculator** to Applications, then right-click the app and choose **Open**.

A new install has no classes and no grades. Everything you enter stays on that computer. Later versions are installed from **Settings → Update**.

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

While developing, data is stored in `data/grades.db` (gitignored). Packaged apps store it in Application Support (Mac) or AppData (Windows).

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
