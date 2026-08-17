from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.database import Base, get_db
from backend.main import app


def make_client(tmp_path):
    eng = create_engine(
        f"sqlite:///{tmp_path / 'test.db'}",
        connect_args={"check_same_thread": False},
    )
    TestingSession = sessionmaker(bind=eng, autoflush=False, autocommit=False)
    Base.metadata.create_all(eng)

    def override():
        db = TestingSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    return TestClient(app)


def teardown():
    app.dependency_overrides.clear()


def test_semester_course_grade_flow(tmp_path):
    client = make_client(tmp_path)
    try:
        semesters = client.get("/api/semesters").json()
        assert len(semesters) == 1
        sem_id = semesters[0]["id"]

        created = client.post(
            "/api/semesters", json={"year": 2025, "season": "fall", "included": True}
        )
        assert created.status_code == 200
        assert created.json()["name"] == "2025 Fall"
        renamed = client.patch(f"/api/semesters/{created.json()['id']}", json={"year": 2024, "season": "spring"})
        assert renamed.status_code == 200
        assert renamed.json()["name"] == "2024 Spring"
        again = client.post("/api/semesters", json={"year": 2024, "season": "spring"})
        assert again.status_code == 409

        created = client.post(
            "/api/courses",
            json={"semester_id": sem_id, "code": "MA 407", "credits": 3},
        ).json()
        cid = created["id"]

        client.post(
            "/api/categories",
            json={
                "course_id": cid,
                "name": "HW",
                "weight": 0.27,
                "aggregation": "drop_lowest",
                "drop_count": 1,
            },
        )
        client.post(
            "/api/categories",
            json={"course_id": cid, "name": "Quiz", "weight": 0.05, "aggregation": "average"},
        )
        client.post(
            "/api/categories",
            json={"course_id": cid, "name": "Final", "weight": 0.3, "aggregation": "average"},
        )
        course = client.get(f"/api/courses/{cid}").json()
        hw_id = next(c["id"] for c in course["categories"] if c["name"] == "HW")
        for score in ["95", "90", "100", "80", "99.14", "100", "71", "100", "70.1"]:
            client.post("/api/assignments", json={"category_id": hw_id, "score": score})

        course = client.get(f"/api/courses/{cid}").json()
        hw = next(c for c in course["categories"] if c["name"] == "HW")
        assert abs(hw["percent"] - 91.8925) < 1e-4
        assert course["percent"] is not None

        # MAE 310-style tests: per-item weight + bonus, final what-if
        other = client.post(
            "/api/courses",
            json={"semester_id": sem_id, "code": "MAE 310", "credits": 3},
        ).json()
        oid = other["id"]
        client.post("/api/categories", json={"course_id": oid, "name": "HW", "weight": 0.15, "aggregation": "average_plus_bonus"})
        client.post(
            "/api/categories",
            json={"course_id": oid, "name": "Tests", "weight": 0, "weight_per_item": 0.15, "aggregation": "average_plus_bonus"},
        )
        client.post("/api/categories", json={"course_id": oid, "name": "Final", "weight": 0.4, "aggregation": "average"})
        other = client.get(f"/api/courses/{oid}").json()
        ids = {c["name"]: c["id"] for c in other["categories"]}
        client.post("/api/assignments", json={"category_id": ids["HW"], "score": "100", "is_bonus": True})
        for s in ["99", "96", "96", "100", "99", "94", "98"]:
            client.post("/api/assignments", json={"category_id": ids["HW"], "score": s})
        for s in ["92", "92", "98"]:
            client.post("/api/assignments", json={"category_id": ids["Tests"], "score": s})
        client.post("/api/assignments", json={"category_id": ids["Tests"], "score": "10", "is_bonus": True})
        client.post("/api/assignments", json={"category_id": ids["Tests"], "score": "50", "is_bonus": True})
        other = client.get(f"/api/courses/{oid}").json()
        tests = next(c for c in other["categories"] if c["name"] == "Tests")
        assert abs(tests["effective_weight"] - 0.45) < 1e-9
        assert abs(tests["percent"] - 114) < 1e-6
        a_plus = next(w for w in other["what_if"] if w["letter"] == "A+" and w["category_name"] == "Final")
        assert abs(a_plus["needed"] - 72.357) < 0.05

        gpa = client.get("/api/gpa").json()
        assert gpa["target_letter"] == "A"
        assert any(t["course_count"] >= 1 for t in gpa["terms"])
    finally:
        teardown()


def test_meta_includes_version_and_downloads(tmp_path):
    client = make_client(tmp_path)
    try:
        body = client.get("/api/meta").json()
        assert body["version"]
        assert "windows" in body["downloads"]
        assert "macos" in body["downloads"]
        assert body["release_url"].endswith("/releases/latest")
    finally:
        teardown()
