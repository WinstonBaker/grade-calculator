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
                "aggregation": "average",
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
        client.post("/api/categories", json={"course_id": oid, "name": "HW", "weight": 0.15, "aggregation": "average", "include_bonus": True})
        client.post(
            "/api/categories",
            json={"course_id": oid, "name": "Tests", "weight": 0, "weight_per_item": 0.15, "aggregation": "average", "include_bonus": True},
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
        assert any(p["id"] == "unc" for p in body["scale_presets"])
        assert body["aggregations"] == ["average", "points_ratio"]
        assert body["aggregation_labels"]["average"] == "Average"
        assert body["aggregation_labels"]["points_ratio"] == "Points ratio"
        preset_ids = {p["id"] for p in body["scale_presets"]}
        assert preset_ids == {"ncsu", "unc", "clemson", "ecu", "uncw", "uncc", "duke", "cofc"}
        assert body["default_scale"][0]["letter"] == "A+"
        profiles = body["scale_profiles"]
        assert len(profiles) == 1
        assert profiles[0]["name"] == "Default 1"
        assert profiles[0]["is_primary"] is True
        assert profiles[0]["rows"][0]["quality_points"] == 4.333
    finally:
        teardown()


def test_default_scale_copied_to_new_courses(tmp_path):
    client = make_client(tmp_path)
    try:
        unc = next(p for p in client.get("/api/meta").json()["scale_presets"] if p["id"] == "unc")
        saved = client.patch("/api/settings", json={"default_scale": unc["rows"], "target_letter": "A+"})
        assert saved.status_code == 200
        body = saved.json()
        assert body["target_letter"] == "A"
        assert all(row["letter"] != "A+" for row in body["default_scale"])

        sem_id = client.get("/api/semesters").json()[0]["id"]
        course = client.post(
            "/api/courses",
            json={"semester_id": sem_id, "code": "CHEM 101", "credits": 3},
        ).json()
        letters = [row["letter"] for row in course["scale"]]
        assert "A+" not in letters
        assert letters[0] == "A"
        assert course["scale"][0]["quality_points"] == 4.0
        assert course["scale_profile_id"] is not None

        reset = client.post(f"/api/courses/{course['id']}/scale/default")
        assert reset.status_code == 200
        assert [row["letter"] for row in reset.json()["scale"]] == letters

        capped = next(p for p in client.get("/api/meta").json()["scale_presets"] if p["id"] == "duke")
        client.patch("/api/settings", json={"default_scale": capped["rows"]})
        other = client.post(
            "/api/courses",
            json={"semester_id": sem_id, "code": "CHEM 102", "credits": 3},
        ).json()
        a_plus = next(row for row in other["scale"] if row["letter"] == "A+")
        a_row = next(row for row in other["scale"] if row["letter"] == "A")
        assert a_plus["quality_points"] == a_row["quality_points"] == 4.0
    finally:
        teardown()


def test_optional_gpa_cap_preserves_aplus_score(tmp_path):
    client = make_client(tmp_path)
    try:
        sem_id = client.get("/api/semesters").json()[0]["id"]
        course = client.post(
            "/api/courses",
            json={
                "semester_id": sem_id,
                "code": "HON 101",
                "credits": 3,
                "gp_override": 4.333,
            },
        ).json()
        assert course["quality_points"] == 4.333
        assert course["score"] == 3

        uncapped = client.get("/api/gpa").json()
        assert uncapped["gpa_cap"] is None
        assert abs(uncapped["overall_gpa"] - 4.333) < 0.001
        assert uncapped["terms"][0]["term_gpa"] == 4.333

        capped = client.patch("/api/settings", json={"gpa_cap": 4.0}).json()
        assert capped["gpa_cap"] == 4.0
        assert capped["overall_gpa"] == 4.0
        assert capped["terms"][0]["term_gpa"] == 4.0
        assert capped["overall_score"] == 3
        assert client.get("/api/semesters").json()[0]["term_gpa"] == 4.0

        restored = client.patch("/api/settings", json={"gpa_cap": None}).json()
        assert restored["gpa_cap"] is None
        assert abs(restored["overall_gpa"] - 4.333) < 0.001
    finally:
        teardown()


def test_scale_profile_crud_and_course_apply(tmp_path):
    client = make_client(tmp_path)
    try:
        profiles = client.get("/api/scale-profiles").json()
        assert len(profiles) == 1
        primary = profiles[0]
        assert primary["name"] == "Default 1"
        assert primary["rows"][0]["quality_points"] == 4.333

        cloned = client.post("/api/scale-profiles", json={}).json()
        assert cloned["name"] == "Default 2"
        assert cloned["is_primary"] is False
        assert cloned["rows"][0]["quality_points"] == 4.333

        unc = next(p for p in client.get("/api/meta").json()["scale_presets"] if p["id"] == "unc")
        updated = client.patch(f"/api/scale-profiles/{cloned['id']}", json={"rows": unc["rows"], "name": "Transfer"}).json()
        assert updated["name"] == "Transfer"
        assert all(row["letter"] != "A+" for row in updated["rows"])

        listed = client.get("/api/scale-profiles").json()
        assert [p["name"] for p in listed] == ["Default 1", "Transfer"]

        sem_id = client.get("/api/semesters").json()[0]["id"]
        first = client.post("/api/courses", json={"semester_id": sem_id, "code": "MA 101", "credits": 3}).json()
        assert first["scale_profile_id"] == primary["id"]
        assert first["scale"][0]["letter"] == "A+"
        assert first["scale"][0]["quality_points"] == 4.333

        applied = client.post(
            f"/api/courses/{first['id']}/scale/default",
            json={"scale_profile_id": cloned["id"]},
        ).json()
        assert applied["scale_profile_id"] == cloned["id"]
        assert applied["scale"][0]["letter"] == "A"
        assert applied["scale"][0]["quality_points"] == 4.0

        custom_rows = [{**row} for row in applied["scale"]]
        custom_rows[0]["min_percent"] = 94
        custom = client.put(f"/api/courses/{first['id']}/scale", json={"rows": custom_rows}).json()
        assert custom["scale_profile_id"] is None
        assert custom["scale"][0]["min_percent"] == 94

        promoted = client.patch(f"/api/scale-profiles/{cloned['id']}", json={"is_primary": True}).json()
        assert promoted["is_primary"] is True
        second = client.post("/api/courses", json={"semester_id": sem_id, "code": "CH 101", "credits": 3}).json()
        assert second["scale_profile_id"] == cloned["id"]
        assert second["scale"][0]["letter"] == "A"

        deleted = client.delete(f"/api/scale-profiles/{cloned['id']}")
        assert deleted.status_code == 200
        leftover = client.get("/api/scale-profiles").json()
        assert len(leftover) == 1
        assert leftover[0]["is_primary"] is True
        assert leftover[0]["id"] == primary["id"]
        after_delete = client.get(f"/api/courses/{second['id']}").json()
        assert after_delete["scale_profile_id"] is None
        assert after_delete["scale"][0]["letter"] == "A"

        blocked = client.delete(f"/api/scale-profiles/{primary['id']}")
        assert blocked.status_code == 400
    finally:
        teardown()


def test_identical_school_presets_keep_selected_name(tmp_path):
    client = make_client(tmp_path)
    try:
        presets = {p["id"]: p for p in client.get("/api/meta").json()["scale_presets"]}
        profile_id = client.get("/api/scale-profiles").json()[0]["id"]

        uncc = client.patch(
            f"/api/scale-profiles/{profile_id}",
            json={"rows": presets["uncc"]["rows"], "preset_id": "uncc"},
        ).json()
        assert uncc["preset_id"] == "uncc"
        assert uncc["rows"] == presets["clemson"]["rows"]

        clemson = client.patch(
            f"/api/scale-profiles/{profile_id}",
            json={"rows": presets["clemson"]["rows"], "preset_id": "clemson"},
        ).json()
        assert clemson["preset_id"] == "clemson"
    finally:
        teardown()


def test_legacy_aggregation_maps_to_knobs(tmp_path):
    client = make_client(tmp_path)
    try:
        sem_id = client.get("/api/semesters").json()[0]["id"]
        cid = client.post("/api/courses", json={"semester_id": sem_id, "code": "CSC 101", "credits": 3}).json()["id"]
        client.post(
            "/api/categories",
            json={"course_id": cid, "name": "HW", "weight": 0.2, "aggregation": "drop_lowest"},
        )
        client.post(
            "/api/categories",
            json={"course_id": cid, "name": "Labs", "weight": 0.2, "aggregation": "average_plus_bonus"},
        )
        client.post(
            "/api/categories",
            json={"course_id": cid, "name": "Tests", "weight": 0.4, "aggregation": "replace_min_with"},
        )
        course = client.get(f"/api/courses/{cid}").json()
        by_name = {c["name"]: c for c in course["categories"]}
        assert by_name["HW"]["aggregation"] == "average"
        assert by_name["HW"]["drop_count"] == 1
        assert by_name["HW"]["include_bonus"] is False
        assert by_name["Labs"]["aggregation"] == "average"
        assert by_name["Labs"]["include_bonus"] is True
        assert by_name["Labs"]["drop_count"] == 0
        assert by_name["Tests"]["aggregation"] == "average"
        assert by_name["Tests"]["drop_count"] == 0
        rejected = client.patch(
            f"/api/categories/{by_name['HW']['id']}",
            json={"drop_count": -1},
        )
        assert rejected.status_code == 422
    finally:
        teardown()


def test_migrate_legacy_category_modes(tmp_path):
    from sqlalchemy import create_engine, text

    from backend.database import migrate_legacy_category_modes

    eng = create_engine(f"sqlite:///{tmp_path / 'migrate.db'}")
    with eng.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE categories ("
                "id INTEGER PRIMARY KEY, aggregation VARCHAR(32), drop_count INTEGER, include_bonus BOOLEAN DEFAULT 0)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO categories (aggregation, drop_count, include_bonus) VALUES "
                "('average', 1, 0), ('drop_lowest', 2, 0), ('average_plus_bonus', 1, 0), "
                "('replace_min_with', 1, 0), ('points_ratio', 1, 0)"
            )
        )
        migrate_legacy_category_modes(conn, reset_plain_drop_counts=True)
        rows = list(conn.execute(text("SELECT aggregation, drop_count, include_bonus FROM categories ORDER BY id")))
    assert rows[0][0] == "average" and rows[0][1] == 0 and not rows[0][2]
    assert rows[1][0] == "average" and rows[1][1] == 2 and not rows[1][2]
    assert rows[2][0] == "average" and rows[2][1] == 0 and rows[2][2]
    assert rows[3][0] == "average" and rows[3][1] == 0 and not rows[3][2]
    assert rows[4][0] == "points_ratio" and rows[4][1] == 0 and not rows[4][2]


def test_transfer_semester_and_level_stats(tmp_path):
    client = make_client(tmp_path)
    try:
        created = client.post("/api/semesters", json={"year": 2024, "season": "transfer", "included": True})
        assert created.status_code == 200
        assert created.json()["name"] == "2024 Transfer"
        assert created.json()["season"] == "transfer"
        bad = client.post("/api/semesters", json={"year": 2024, "season": "winter"})
        assert bad.status_code == 400
        assert "transfer" in client.get("/api/meta").json()["seasons"]

        sid = created.json()["id"]
        client.post("/api/courses", json={"semester_id": sid, "code": "MAE 310", "credits": 3, "gp_override": 4.0})
        client.post("/api/courses", json={"semester_id": sid, "code": "MATH 2310", "credits": 4, "gp_override": 3.0})
        client.post("/api/courses", json={"semester_id": sid, "code": "Seminar", "credits": 1, "gp_override": 4.0})
        gpa = client.get("/api/gpa").json()
        levels = {row["level"]: row for row in gpa["level_stats"]}
        assert levels["300"]["courses"] == 1
        assert levels["300"]["credits"] == 3
        assert levels["2000"]["courses"] == 1
        assert levels["other"]["courses"] == 1
    finally:
        teardown()


def test_exam_impact(tmp_path):
    client = make_client(tmp_path)
    try:
        sem_id = client.get("/api/semesters").json()[0]["id"]
        course = client.post("/api/courses", json={"semester_id": sem_id, "code": "PY 205", "credits": 3}).json()
        cid = course["id"]
        client.post("/api/categories", json={"course_id": cid, "name": "Tests", "weight": 0.6, "aggregation": "average"})
        client.post("/api/categories", json={"course_id": cid, "name": "Final", "weight": 0.4, "aggregation": "average"})
        course = client.get(f"/api/courses/{cid}").json()
        ids = {c["name"]: c["id"] for c in course["categories"]}
        client.post("/api/assignments", json={"category_id": ids["Tests"], "score": "80"})
        client.post("/api/assignments", json={"category_id": ids["Final"], "score": "95"})
        patched = client.patch(
            f"/api/courses/{cid}",
            json={"test_category_id": ids["Tests"], "exam_category_id": ids["Final"]},
        ).json()
        impact = patched["exam_impact"]
        assert impact["delta"] == 15
        assert impact["letter_change"] in {"up", "down", "same"}
        gpa = client.get("/api/gpa").json()
        assert gpa["exam_impact"]["cumulative"]["with_exam"] == 1
    finally:
        teardown()


def test_appearance_persists(tmp_path):
    client = make_client(tmp_path)
    try:
        assert client.get("/api/appearance").json() is None
        saved = client.put(
            "/api/appearance",
            json={
                "gradeColors": False,
                "showScore": True,
                "gradeScale": "spectrum",
                "primary": "#112233",
                "secondary": "#445566",
                "tertiary": "#778899",
                "themeScale": "custom",
                "autoContrastText": False,
                "textColor": "#abcdef",
            },
        ).json()
        assert saved["gradeScale"] == "spectrum"
        assert saved["textColor"] == "#abcdef"
        loaded = client.get("/api/appearance").json()
        assert loaded["gradeColors"] is False
        assert loaded["autoContrastText"] is False
    finally:
        teardown()


def test_grade_snapshots_and_prompt(tmp_path):
    client = make_client(tmp_path)
    try:
        sem_id = client.get("/api/semesters").json()[0]["id"]
        course = client.post(
            "/api/courses",
            json={"semester_id": sem_id, "code": "CSC 101", "credits": 3},
        ).json()
        cat = client.post(
            "/api/categories",
            json={"course_id": course["id"], "name": "Exams", "weight": 1, "aggregation": "average"},
        ).json()
        assignment = client.post(
            "/api/assignments", json={"category_id": cat["id"], "name": "Midterm", "score": "90"}
        ).json()
        assignment_id = next(
            item["id"]
            for category in assignment["categories"]
            for item in category["assignments"]
            if item["name"] == "Midterm"
        )

        prompt = client.get("/api/grade-prompt").json()
        assert prompt["due"] is True
        assert prompt["recording_interval_days"] == 7
        assert any(s["id"] == sem_id for s in prompt["semesters"])
        assert prompt["default_semester_id"] in {s["id"] for s in prompt["semesters"]}

        snap = client.post(f"/api/semesters/{sem_id}/snapshots").json()
        assert snap["term_gpa"] is not None
        assert snap["courses"][0]["code"] == "CSC 101"
        assert snap["courses"][0]["percent"] == 90

        listed = client.get(f"/api/semesters/{sem_id}/snapshots").json()
        assert len(listed) == 1

        client.patch(f"/api/assignments/{assignment_id}", json={"score": "80"})
        updated = client.post(f"/api/semesters/{sem_id}/snapshots").json()
        listed_again = client.get(f"/api/semesters/{sem_id}/snapshots").json()
        assert len(listed_again) == 1
        assert listed_again[0]["id"] == snap["id"]
        assert listed_again[0]["courses"][0]["percent"] == 80
        assert updated["id"] == snap["id"]

        prompt_after = client.get("/api/grade-prompt").json()
        assert prompt_after["due"] is False

        snoozed = client.post("/api/grade-prompt/snooze").json()
        assert snoozed["snooze_until"] is not None

        removed = client.request(
            "DELETE",
            f"/api/semesters/{sem_id}/snapshots",
            json={"ids": [snap["id"]]},
        ).json()
        assert removed["deleted"] == 1
        assert client.get(f"/api/semesters/{sem_id}/snapshots").json() == []

        patched = client.patch("/api/settings", json={"recording_interval_days": 14}).json()
        assert patched["recording_interval_days"] == 14
    finally:
        teardown()


def test_progression_lock_and_default_semester(tmp_path):
    client = make_client(tmp_path)
    try:
        first = client.get("/api/semesters").json()[0]
        first_id = first["id"]
        course = client.post(
            "/api/courses",
            json={"semester_id": first_id, "code": "CSC 101", "credits": 3},
        ).json()
        cat = client.post(
            "/api/categories",
            json={"course_id": course["id"], "name": "Exams", "weight": 1, "aggregation": "average"},
        ).json()
        client.post("/api/assignments", json={"category_id": cat["id"], "name": "Midterm", "score": "90"})

        client.patch("/api/settings", json={"default_recording_semester_id": first_id})
        locked = client.patch(f"/api/semesters/{first_id}", json={"progression_locked": True}).json()
        assert locked["progression_locked"] is True
        denied = client.post(f"/api/semesters/{first_id}/snapshots")
        assert denied.status_code == 409

        prompt = client.get("/api/grade-prompt").json()
        assert prompt["due"] is False
        assert prompt["default_semester_id"] == first_id
        assert any(s["id"] == first_id and s["progression_locked"] for s in prompt["semesters"])

        client.patch(f"/api/semesters/{first_id}", json={"progression_locked": False})
        prompt_open = client.get("/api/grade-prompt").json()
        assert prompt_open["due"] is True

        created = client.post(
            "/api/semesters",
            json={"year": first["year"] + 1, "season": "spring", "included": True, "lock_previous": True},
        )
        assert created.status_code == 200
        after = {s["id"]: s for s in client.get("/api/semesters").json()}
        assert after[first_id]["progression_locked"] is True
        assert after[created.json()["id"]]["progression_locked"] is False
        listed = client.get("/api/grade-prompt").json()
        assert {s["id"] for s in listed["semesters"]} == set(after)
        assert listed["due"] is True
        assert listed["default_semester_id"] == first_id
    finally:
        teardown()

