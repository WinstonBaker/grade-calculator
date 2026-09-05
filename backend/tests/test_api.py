from fastapi.testclient import TestClient
import pytest
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
        duplicate_course = client.post(
            "/api/courses",
            json={"semester_id": sem_id, "code": " ma 407 ", "credits": 3},
        )
        assert duplicate_course.status_code == 409

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


def test_class_names_are_alphabetical_within_terms(tmp_path):
    client = make_client(tmp_path)
    try:
        semester = client.get("/api/semesters").json()[0]
        created = [
            client.post(
                "/api/courses",
                json={"semester_id": semester["id"], "code": code, "credits": index + 1},
            ).json()
            for index, code in enumerate(("Zoology", "alpha", "Biology", "Calculus"))
        ]
        expected = ["alpha", "Biology", "Calculus", "Zoology"]

        listed_term = next(
            item for item in client.get("/api/semesters").json()
            if item["id"] == semester["id"]
        )
        assert [item["code"] for item in listed_term["courses"]] == expected
        credits_desc = client.get(
            f"/api/courses?semester_id={semester['id']}&sort=credits&desc=true"
        ).json()
        assert [item["code"] for item in credits_desc] == ["Calculus", "Biology", "alpha", "Zoology"]
        gpa_term = next(item for item in client.get("/api/gpa").json()["terms"] if item["id"] == semester["id"])
        assert [item["code"] for item in gpa_term["courses"]] == expected

        inventory = client.post(
            "/api/gradebook-setups/inventory",
            json={"gradebooks": [{"id": "gradebook-1", "name": "Source"}]},
        ).json()
        inventory_term = next(
            term
            for period in inventory["gradebooks"][0]["periods"]
            for term in period["terms"]
            if term["id"] == semester["id"]
        )
        assert [item["name"] for item in inventory_term["classes"]] == expected

        payload = client.post(
            "/api/gradebook-setups/export",
            json={"gradebooks": [{
                "id": "gradebook-1",
                "name": "Source",
                "term_ids": [semester["id"]],
                "course_ids": [item["id"] for item in created],
            }]},
        ).json()
        exported_term = payload["gradebooks"][0]["periods"][0]["terms"][0]
        assert [item["code"] for item in exported_term["classes"]] == expected
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


def test_gradebook_setup_export_import_excludes_entered_grades(tmp_path):
    client = make_client(tmp_path)
    try:
        semester = client.get("/api/semesters?gradebook_id=gradebook-1").json()[0]
        course = client.post(
            "/api/courses?gradebook_id=gradebook-1",
            json={"semester_id": semester["id"], "code": "BIO 101", "credits": 3},
        ).json()
        category = client.post(
            "/api/categories?gradebook_id=gradebook-1",
            json={"course_id": course["id"], "name": "Labs", "weight": 1},
        ).json()
        client.post(
            "/api/assignments?gradebook_id=gradebook-1",
            json={"category_id": category["id"], "name": "Lab 1", "score": "95"},
        )

        inventory = client.post(
            "/api/gradebook-setups/inventory",
            json={"gradebooks": [{"id": "gradebook-1", "name": "Source"}]},
        )
        assert inventory.status_code == 200
        term = next(
            item
            for period in inventory.json()["gradebooks"][0]["periods"]
            for item in period["terms"]
            if any(row["id"] == course["id"] for row in item["classes"])
        )
        exported = client.post(
            "/api/gradebook-setups/export",
            json={"gradebooks": [{
                "id": "gradebook-1",
                "name": "Source",
                "term_ids": [term["id"]],
                "course_ids": [course["id"]],
            }]},
        )
        assert exported.status_code == 200
        payload = exported.json()
        exported_course = payload["gradebooks"][0]["periods"][0]["terms"][0]["classes"][0]
        assert "assignments" not in exported_course
        assert "gp_override" not in exported_course
        assert exported_course["categories"][0]["name"] == "Labs"

        imported = client.post(
            "/api/gradebook-setups/import",
            json={"payload": payload, "plan": [{
                "source_id": "gradebook-1",
                "destination_mode": "new",
                "destination_id": "gradebook-2",
                "destination_name": "Imported",
                "apply_settings": True,
                "conflict_strategy": "copy",
                "term_destinations": {term["key"]: "new"},
                "period_destinations": {},
            }]},
        )
        assert imported.status_code == 200
        assert imported.json()["gradebooks"][0]["imported_courses"] == 1
        copied = client.get("/api/semesters?gradebook_id=gradebook-2").json()
        copied_course = next(row for item in copied for row in item["courses"] if row["code"] == "BIO 101")
        assert copied_course["categories"][0]["name"] == "Labs"
        assert copied_course["categories"][0]["assignments"] == []
    finally:
        teardown()


def test_gradebook_setup_import_places_class_in_selected_target_term(tmp_path):
    client = make_client(tmp_path)
    try:
        source_term = client.get("/api/semesters?gradebook_id=gradebook-1").json()[0]
        source_course = client.post(
            "/api/courses?gradebook_id=gradebook-1",
            json={"semester_id": source_term["id"], "code": "Mapped Class", "credits": 3},
        ).json()
        target_term = client.post(
            "/api/semesters?gradebook_id=gradebook-2",
            json={"year": 2038, "season": "spring", "included": True},
        ).json()

        inventory = client.post(
            "/api/gradebook-setups/inventory",
            json={"gradebooks": [{"id": "gradebook-1", "name": "Source"}]},
        ).json()
        source_export_term = next(
            term
            for period in inventory["gradebooks"][0]["periods"]
            for term in period["terms"]
            if any(item["id"] == source_course["id"] for item in term["classes"])
        )
        payload = client.post(
            "/api/gradebook-setups/export",
            json={"gradebooks": [{
                "id": "gradebook-1",
                "name": "Source",
                "term_ids": [source_export_term["id"]],
                "course_ids": [source_course["id"]],
            }]},
        ).json()
        exported_course = payload["gradebooks"][0]["periods"][0]["terms"][0]["classes"][0]

        imported = client.post(
            "/api/gradebook-setups/import",
            json={"payload": payload, "plan": [{
                "source_id": "gradebook-1",
                "destination_mode": "existing",
                "destination_id": "gradebook-2",
                "destination_name": "Target",
                "apply_settings": False,
                "conflict_strategy": "copy",
                "term_destinations": {source_export_term["key"]: "new"},
                "period_destinations": {},
                "class_destinations": {exported_course["key"]: str(target_term["id"])},
            }]},
        )
        assert imported.status_code == 200
        imported_terms = client.get("/api/semesters?gradebook_id=gradebook-2").json()
        mapped_term = next(item for item in imported_terms if item["id"] == target_term["id"])
        assert any(item["code"] == "Mapped Class" for item in mapped_term["courses"])
    finally:
        teardown()


def test_gradebook_setup_import_converts_individual_class_between_types(tmp_path):
    client = make_client(tmp_path)
    try:
        client.patch(
            "/api/settings?gradebook_id=gradebook-1",
            json={"gradebook_type": "high_school", "gpa_basis": "classes"},
        )
        source_term = client.get("/api/semesters?gradebook_id=gradebook-1").json()[0]
        source_course = client.post(
            "/api/courses?gradebook_id=gradebook-1",
            json={"semester_id": source_term["id"], "code": "Converted Class", "credits": 1},
        ).json()
        target_term = client.post(
            "/api/semesters?gradebook_id=gradebook-2",
            json={"year": 2039, "season": "fall", "included": True},
        ).json()
        terms_before = client.get("/api/semesters?gradebook_id=gradebook-2").json()

        inventory = client.post(
            "/api/gradebook-setups/inventory",
            json={"gradebooks": [{"id": "gradebook-1", "name": "Multi-term source"}]},
        ).json()
        source_export_term = next(
            term
            for period in inventory["gradebooks"][0]["periods"]
            for term in period["terms"]
            if any(item["id"] == source_course["id"] for item in term["classes"])
        )
        payload = client.post(
            "/api/gradebook-setups/export",
            json={"gradebooks": [{
                "id": "gradebook-1",
                "name": "Multi-term source",
                "term_ids": [source_export_term["id"]],
                "course_ids": [source_course["id"]],
            }]},
        ).json()
        exported_course = payload["gradebooks"][0]["periods"][0]["terms"][0]["classes"][0]

        imported = client.post(
            "/api/gradebook-setups/import",
            json={"payload": payload, "plan": [{
                "source_id": "gradebook-1",
                "destination_mode": "existing",
                "destination_id": "gradebook-2",
                "destination_name": "Single-term target",
                "apply_settings": False,
                "conflict_strategy": "copy",
                "term_destinations": {source_export_term["key"]: "new"},
                "period_destinations": {},
                "class_destinations": {exported_course["key"]: str(target_term["id"])},
            }]},
        )
        assert imported.status_code == 200
        imported_terms = client.get("/api/semesters?gradebook_id=gradebook-2").json()
        assert len(imported_terms) == len(terms_before)
        mapped_term = next(item for item in imported_terms if item["id"] == target_term["id"])
        assert any(item["code"] == "Converted Class" for item in mapped_term["courses"])
    finally:
        teardown()


def test_gradebook_setup_import_places_selected_classes_in_matching_new_terms(tmp_path):
    client = make_client(tmp_path)
    try:
        for gradebook_id in ("gradebook-1", "gradebook-2"):
            updated = client.patch(
                f"/api/settings?gradebook_id={gradebook_id}",
                json={"gradebook_type": "high_school", "gpa_basis": "classes"},
            )
            assert updated.status_code == 200

        source_terms = [
            client.post(
                "/api/semesters?gradebook_id=gradebook-1",
                json={"year": 2040, "season": season, "included": True},
            ).json()
            for season in ("term 1", "term 2")
        ]
        client.post(
            "/api/academic-years?gradebook_id=gradebook-1",
            json={"name": "Source period", "semester_ids": [item["id"] for item in source_terms]},
        )
        art_courses = []
        for term in source_terms:
            art_courses.append(client.post(
                "/api/courses?gradebook_id=gradebook-1",
                json={"semester_id": term["id"], "code": "Art I", "credits": 1},
            ).json())
            client.post(
                "/api/courses?gradebook_id=gradebook-1",
                json={"semester_id": term["id"], "code": "Other Class", "credits": 1},
            )

        target_terms = [
            client.post(
                "/api/semesters?gradebook_id=gradebook-2",
                json={"year": 2040, "season": season, "included": True},
            ).json()
            for season in ("fall", "spring")
        ]
        target_period = client.post(
            "/api/academic-years?gradebook_id=gradebook-2",
            json={"name": "Target period", "semester_ids": [item["id"] for item in target_terms]},
        ).json()

        inventory = client.post(
            "/api/gradebook-setups/inventory",
            json={"gradebooks": [{"id": "gradebook-1", "name": "Source"}]},
        ).json()
        exported_period = next(
            period
            for period in inventory["gradebooks"][0]["periods"]
            if {term["id"] for term in period["terms"]} >= {item["id"] for item in source_terms}
        )
        payload = client.post(
            "/api/gradebook-setups/export",
            json={"gradebooks": [{
                "id": "gradebook-1",
                "name": "Source",
                "term_ids": [item["id"] for item in source_terms],
                "course_ids": [item["id"] for item in art_courses],
            }]},
        ).json()
        exported_terms = {
            term["key"]: term
            for period in payload["gradebooks"][0]["periods"]
            for term in period["terms"]
        }
        source_term_keys = {f"term-{item['id']}" for item in source_terms}
        assert {term["name"] for term in exported_terms.values()} >= {"Term 1", "Term 2"}
        assert all(
            [course["code"] for course in term["classes"]] == ["Art I"]
            for term in exported_terms.values()
            if term["key"] in source_term_keys
        )

        imported = client.post(
            "/api/gradebook-setups/import",
            json={"payload": payload, "plan": [{
                "source_id": "gradebook-1",
                "destination_mode": "existing",
                "destination_id": "gradebook-2",
                "destination_name": "Target",
                "apply_settings": False,
                "conflict_strategy": "copy",
                "term_destinations": {key: "new" for key in exported_terms},
                "period_destinations": {exported_period["key"]: "new"},
                "class_destinations": {
                    term["classes"][0]["key"]: f"period:{target_period['id']}"
                    for term in exported_terms.values()
                },
            }]},
        )
        assert imported.status_code == 200
        assert imported.json()["gradebooks"][0]["imported_courses"] == 2

        target_semesters = client.get("/api/semesters?gradebook_id=gradebook-2").json()
        target_period_after = next(
            item
            for item in client.get("/api/academic-years?gradebook_id=gradebook-2").json()
            if item["id"] == target_period["id"]
        )
        new_terms = [
            item
            for item in target_semesters
            if item["id"] in set(target_period_after["semester_ids"])
            and item["id"] not in {term["id"] for term in target_terms}
        ]
        assert {item["name"] for item in new_terms} == {"Term 1", "Term 2"}
        assert all([course["code"] for course in item["courses"]] == ["Art I"] for item in new_terms)
        assert all(
            item["name"] != "Source period"
            for item in client.get("/api/academic-years?gradebook_id=gradebook-2").json()
        )
    finally:
        teardown()


def test_gradebook_type_is_scoped_per_gradebook(tmp_path):
    client = make_client(tmp_path)
    try:
        assert client.get("/api/gpa?gradebook_id=gradebook-1").json()["gradebook_type"] == "college"
        assert client.get("/api/gpa?gradebook_id=gradebook-2").json()["gradebook_type"] == "college"

        updated = client.patch(
            "/api/settings?gradebook_id=gradebook-1",
            json={"gradebook_type": "high_school"},
        )
        assert updated.status_code == 200
        assert updated.json()["gradebook_type"] == "high_school"
        high_school_term = client.get("/api/semesters?gradebook_id=gradebook-1").json()[0]
        assert high_school_term["name"] == high_school_term["season"].title()
        inventory = client.post(
            "/api/gradebook-setups/inventory",
            json={"gradebooks": [{"id": "gradebook-1", "name": "Source"}]},
        ).json()
        inventory_term = next(
            term
            for period in inventory["gradebooks"][0]["periods"]
            for term in period["terms"]
            if term["id"] == high_school_term["id"]
        )
        assert inventory_term["name"] == high_school_term["season"].title()
        assert client.get("/api/gpa?gradebook_id=gradebook-1").json()["gradebook_type"] == "high_school"
        assert client.get("/api/gpa?gradebook_id=gradebook-2").json()["gradebook_type"] == "college"

        updated = client.patch(
            "/api/settings?gradebook_id=gradebook-1",
            json={"gradebook_type": "college"},
        )
        assert updated.status_code == 200
        college_term = client.get("/api/semesters?gradebook_id=gradebook-1").json()[0]
        assert college_term["name"] == f"{college_term['year']} {college_term['season'].title()}"
        assert client.get("/api/gpa?gradebook_id=gradebook-1").json()["gradebook_type"] == "college"

        updated = client.patch(
            "/api/settings?gradebook_id=gradebook-2",
            json={"gradebook_type": "college"},
        )
        assert updated.status_code == 200
        assert client.get("/api/gpa?gradebook_id=gradebook-1").json()["gradebook_type"] == "college"
        assert client.get("/api/gpa?gradebook_id=gradebook-2").json()["gradebook_type"] == "college"
    finally:
        teardown()


def test_course_name_is_shared_across_semesters(tmp_path):
    client = make_client(tmp_path)
    try:
        first_semester = client.get("/api/semesters").json()[0]
        second_semester = client.post(
            "/api/semesters", json={"year": 2040, "season": "fall", "included": True}
        ).json()
        first = client.post(
            "/api/courses", json={"semester_id": first_semester["id"], "code": "MATH 101"}
        ).json()
        second = client.post(
            "/api/courses", json={"semester_id": second_semester["id"], "code": "MATH 101"}
        ).json()

        renamed = client.patch(f"/api/courses/{first['id']}", json={"code": "Calculus I"})
        assert renamed.status_code == 200
        assert renamed.json()["code"] == "Calculus I"
        assert client.get(f"/api/courses/{second['id']}").json()["code"] == "Calculus I"
        renamed_codes = [
            course["code"]
            for semester in client.get("/api/semesters").json()
            for course in semester["courses"]
            if course["id"] in {first["id"], second["id"]}
        ]
        assert renamed_codes == ["Calculus I", "Calculus I"]
    finally:
        teardown()


def test_gradebook_data_is_fully_isolated(tmp_path):
    client = make_client(tmp_path)
    try:
        # Legacy terms belong to the default gradebook, while another book can
        # create an identical calendar term without sharing its data.
        default_semester = client.get("/api/semesters?gradebook_id=gradebook-1").json()[0]
        first = client.post(
            "/api/semesters?gradebook_id=gradebook-1",
            json={"year": 2038, "season": "fall", "included": True},
        ).json()
        second_response = client.post(
            "/api/semesters?gradebook_id=gradebook-2",
            json={"year": 2038, "season": "fall", "included": True},
        )
        assert second_response.status_code == 200
        second = second_response.json()
        assert second["id"] != first["id"]

        course = client.post(
            "/api/courses?gradebook_id=gradebook-1",
            json={"semester_id": first["id"], "code": "ONLY BOOK ONE", "credits": 3},
        ).json()
        category = client.post(
            "/api/categories?gradebook_id=gradebook-1",
            json={"course_id": course["id"], "name": "Tests", "weight": 1.0},
        ).json()
        category_id = category["categories"][0]["id"]
        client.post(
            "/api/assignments?gradebook_id=gradebook-1",
            json={"category_id": category_id, "name": "Midterm", "score": "92"},
        )
        assert client.get(
            "/api/courses",
            params={"semester_id": first["id"], "gradebook_id": "gradebook-2"},
        ).json() == []
        assert client.get(f"/api/courses/{course['id']}?gradebook_id=gradebook-2").status_code == 404
        assert client.patch(
            f"/api/courses/{course['id']}?gradebook_id=gradebook-2",
            json={"code": "SHOULD NOT MOVE"},
        ).status_code == 404
        assert client.patch(f"/api/categories/{category_id}?gradebook_id=gradebook-2", json={"name": "Nope"}).status_code == 404
        assignment = client.get(f"/api/courses/{course['id']}?gradebook_id=gradebook-1").json()["categories"][0]["assignments"][0]
        assert client.patch(f"/api/assignments/{assignment['id']}?gradebook_id=gradebook-2", json={"name": "Nope"}).status_code == 404
        snapshot = client.post(f"/api/semesters/{first['id']}/snapshots?gradebook_id=gradebook-1")
        assert snapshot.status_code == 200
        assert client.get(f"/api/semesters/{first['id']}/snapshots?gradebook_id=gradebook-2").status_code == 404
        assert client.post(
            "/api/courses?gradebook_id=gradebook-2",
            json={"semester_id": second["id"], "code": "ONLY BOOK TWO", "credits": 3},
        ).status_code == 200

        assert client.post(
            "/api/academic-years?gradebook_id=gradebook-2",
            json={"name": "Cross-book period", "semester_ids": [first["id"]]},
        ).status_code == 404
        first_profiles = client.get("/api/scale-profiles?gradebook_id=gradebook-1").json()
        second_profiles = client.get("/api/scale-profiles?gradebook_id=gradebook-2").json()
        assert first_profiles and second_profiles
        assert first_profiles[0]["id"] != second_profiles[0]["id"]
        client.patch(
            f"/api/scale-profiles/{second_profiles[0]['id']}?gradebook_id=gradebook-2",
            json={"name": "Book Two Scale"},
        )
        assert client.get("/api/scale-profiles?gradebook_id=gradebook-1").json()[0]["name"] != "Book Two Scale"

        assert client.post(
            "/api/fumbles?gradebook_id=gradebook-2",
            json={"course_id": course["id"], "should_have_been_gp": 4.0},
        ).status_code == 404
        assert client.get("/api/gpa?gradebook_id=gradebook-2").json()["fumbles"] == []
        assert client.delete("/api/gradebook-data?gradebook_id=gradebook-2").status_code == 200
        assert client.get("/api/semesters?gradebook_id=gradebook-2").json() == []
        assert any(
            item["id"] in {default_semester["id"], first["id"]}
            for item in client.get("/api/semesters?gradebook_id=gradebook-1").json()
        )
    finally:
        teardown()


def test_grade_prompt_is_program_wide_and_can_record_another_gradebook(tmp_path):
    client = make_client(tmp_path)
    try:
        first = client.get("/api/semesters?gradebook_id=gradebook-1").json()[0]
        second = client.post(
            "/api/semesters?gradebook_id=gradebook-2",
            json={"year": 2038, "season": "spring", "included": True},
        ).json()
        course = client.post(
            "/api/courses?gradebook_id=gradebook-2",
            json={"semester_id": second["id"], "code": "TARGET BOOK", "credits": 3},
        ).json()
        category = client.post(
            "/api/categories?gradebook_id=gradebook-2",
            json={"course_id": course["id"], "name": "Exams", "weight": 1, "aggregation": "average"},
        ).json()
        client.post(
            "/api/assignments?gradebook_id=gradebook-2",
            json={"category_id": category["id"], "name": "Midterm", "score": "90"},
        )

        first_status = client.get("/api/grade-prompt?gradebook_id=gradebook-1").json()
        second_status = client.get("/api/grade-prompt?gradebook_id=gradebook-2").json()
        assert first_status["due"] is True
        assert second_status["due"] is True
        assert first_status["recording_interval_days"] == second_status["recording_interval_days"] == 7
        assert first_status["snooze_until"] == second_status["snooze_until"] is None
        assert {
            (item["id"], item["gradebook_id"])
            for item in first_status["semesters"]
        } == {
            (first["id"], "gradebook-1"),
            (second["id"], "gradebook-2"),
        }

        snoozed = client.post("/api/grade-prompt/snooze?gradebook_id=gradebook-1").json()
        other_view = client.get("/api/grade-prompt?gradebook_id=gradebook-2").json()
        assert snoozed["due"] is False
        assert other_view["due"] is False
        assert other_view["snooze_until"] == snoozed["snooze_until"]

        recorded = client.post(
            f"/api/semesters/{second['id']}/snapshots?gradebook_id=gradebook-2"
        )
        assert recorded.status_code == 200
        after_first = client.get("/api/grade-prompt?gradebook_id=gradebook-1").json()
        after_second = client.get("/api/grade-prompt?gradebook_id=gradebook-2").json()
        assert after_first["due"] is False
        assert after_second["due"] is False
        assert after_first["last_recorded_at"] == after_second["last_recorded_at"]
        assert client.get(
            f"/api/semesters/{first['id']}/snapshots?gradebook_id=gradebook-1"
        ).json() == []
        assert len(client.get(
            f"/api/semesters/{second['id']}/snapshots?gradebook_id=gradebook-2"
        ).json()) == 1
    finally:
        teardown()


def test_grade_prompt_is_unchanged_for_another_or_new_gradebook(tmp_path):
    client = make_client(tmp_path)
    try:
        first = client.get("/api/grade-prompt?gradebook_id=gradebook-1").json()
        other = client.get("/api/grade-prompt?gradebook_id=gradebook-2").json()
        new_book = client.get("/api/grade-prompt?gradebook_id=gradebook-99").json()

        for status in (other, new_book):
            assert status["due"] == first["due"]
            assert status["recording_interval_days"] == first["recording_interval_days"]
            assert status["last_recorded_at"] == first["last_recorded_at"]
            assert status["snooze_until"] == first["snooze_until"]
            assert status["default_semester_id"] == first["default_semester_id"]
            assert status["semesters"] == first["semesters"]
            assert status["academic_periods"] == first["academic_periods"]
    finally:
        teardown()


def test_fumble_cannot_be_added_twice_and_adjusted_gpa_uses_score_formula(tmp_path):
    client = make_client(tmp_path)
    try:
        sem_id = client.post(
            "/api/semesters", json={"year": 2027, "season": "spring", "included": True}
        ).json()["id"]
        course = client.post(
            "/api/courses",
            json={"semester_id": sem_id, "code": "MA 101", "credits": 3, "gp_override": 3.0},
        ).json()
        cid = course["id"]

        created = client.post(
            "/api/fumbles", json={"course_id": cid, "should_have_been_gp": 4.333}
        )
        assert created.status_code == 200
        body = created.json()
        # The B contributes -9 and the A+ contributes +3, so the adjusted
        # score is 3 and GPA is ((3 / 3) + (4 * 3)) / 3 = 4.333.
        assert body["score_with_fumbles"] == 3
        assert abs(body["gpa_with_fumbles"] - 4.3333333333) < 1e-9

        duplicate = client.post(
            "/api/fumbles", json={"course_id": cid, "should_have_been_gp": 4.0}
        )
        assert duplicate.status_code == 409
    finally:
        teardown()


def test_high_school_fumble_replaces_overall_grade_from_final_override(tmp_path):
    client = make_client(tmp_path)
    try:
        settings = client.patch(
            "/api/settings",
            json={"gradebook_type": "high_school", "gpa_basis": "classes"},
        )
        assert settings.status_code == 200
        semester = client.get("/api/semesters").json()[0]
        course = client.post(
            "/api/courses",
            json={"semester_id": semester["id"], "code": "Biology H", "credits": 3},
        ).json()
        assert client.patch(
            f"/api/courses/{course['id']}",
            json={"final_gp_override": 4.0},
        ).status_code == 200

        before = client.get("/api/gpa").json()
        assert before["overall_gpa"] == pytest.approx(4.0)
        assert before["fumbles"] == []

        after = client.post(
            "/api/fumbles",
            json={"course_id": course["id"], "should_have_been_gp": 4.333},
        )
        assert after.status_code == 200
        body = after.json()
        assert len(body["fumbles"]) == 1
        assert body["fumbles"][0]["did_get"] == pytest.approx(4.0)
        assert body["fumbles"][0]["should_have_been_gp"] == pytest.approx(4.333)
        assert body["score_with_fumbles"] == pytest.approx(1.0)
        assert body["gpa_with_fumbles"] == pytest.approx(4.3333333333)
    finally:
        teardown()


def test_high_school_fumble_selection_survives_later_same_class(tmp_path):
    client = make_client(tmp_path)
    try:
        settings = client.patch(
            "/api/settings",
            json={"gradebook_type": "high_school", "gpa_basis": "classes"},
        )
        assert settings.status_code == 200
        earlier = client.post(
            "/api/semesters", json={"year": 2027, "season": "fall", "included": True}
        ).json()
        later = client.post(
            "/api/semesters", json={"year": 2028, "season": "spring", "included": True}
        ).json()
        courses = []
        for semester in (earlier, later):
            course = client.post(
                "/api/courses",
                json={"semester_id": semester["id"], "code": "AP Calculus BC", "credits": 3},
            ).json()
            assert client.patch(
                f"/api/courses/{course['id']}",
                json={"final_gp_override": 4.0},
            ).status_code == 200
            courses.append(course)

        created = client.post(
            "/api/fumbles",
            json={"course_id": courses[0]["id"], "should_have_been_gp": 4.333},
        )
        assert created.status_code == 200
        fumble_id = created.json()["fumbles"][0]["id"]
        row = next(item for item in created.json()["fumbles"] if item["id"] == fumble_id)
        assert row["should_have_been_gp"] == pytest.approx(4.333)
        assert row["excluded"] is False

        updated = client.patch(
            f"/api/fumbles/{fumble_id}",
            json={"should_have_been_gp": 4.0},
        )
        assert updated.status_code == 200
        row = next(item for item in updated.json()["fumbles"] if item["id"] == fumble_id)
        assert row["should_have_been_gp"] == pytest.approx(4.0)
        assert row["excluded"] is False
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


def test_fixed_unit_score_is_used_by_course_term_summary_fumble_and_future_guess(tmp_path):
    client = make_client(tmp_path)
    try:
        semester_id = client.get("/api/semesters").json()[0]["id"]
        courses = [
            client.post(
                "/api/courses",
                json={"semester_id": semester_id, "code": code, "credits": 3, "gp_override": gp},
            ).json()
            for code, gp in (("A+ 101", 4.333), ("A- 102", 3.667), ("B+ 103", 3.333))
        ]

        fixed = client.patch("/api/settings", json={"gpa_basis": "classes"})
        assert fixed.status_code == 200

        listed = client.get("/api/courses?semester_id={}".format(semester_id)).json()
        scores = {row["code"]: row["score"] for row in listed}
        assert scores == {"A+ 101": 1, "A- 102": -1, "B+ 103": -2}

        gpa = client.get("/api/gpa").json()
        term = next(row for row in gpa["terms"] if row["id"] == semester_id)
        assert term["term_score"] == -2
        assert gpa["overall_score"] == pytest.approx(-2)
        assert next(row for row in gpa["level_stats"] if row["level"] == "100")["score"] == -2.0

        fumble_response = client.post(
            "/api/fumbles",
            json={"course_id": courses[1]["id"], "should_have_been_gp": 4.333},
        )
        assert fumble_response.status_code == 200
        with_fumble = fumble_response.json()
        assert with_fumble["fumble_total"] == 2
        assert with_fumble["score_with_fumbles"] == 0

        updated = client.patch(
            "/api/settings",
            json={"future_guess": {"3": {"A+": 1}}},
        )
        assert updated.status_code == 200
        future = updated.json()["future_guess"]
        assert future["extra_credits"] == 1
        assert future["delta_score"] == 1
        assert future["adjusted_score"] == -1
    finally:
        teardown()


def test_high_school_score_uses_unweighted_gpa_with_weighted_classes(tmp_path):
    client = make_client(tmp_path)
    try:
        settings = client.patch(
            "/api/settings",
            json={
                "gradebook_type": "high_school",
                "gpa_basis": "classes",
                "gpa_weight_tags": [
                    {"id": "unweighted", "name": "CP", "boost": 0},
                    {"id": "weighted", "name": "Honors", "boost": 0.5},
                ],
            },
        )
        assert settings.status_code == 200

        semester_id = client.get("/api/semesters").json()[0]["id"]
        course = client.post(
            "/api/courses",
            json={
                "semester_id": semester_id,
                "code": "ENG 101",
                "credits": 3,
                "gp_override": 3.0,
                "gpa_weight_tag": "weighted",
            },
        ).json()

        assert course["base_quality_points"] == 3.0
        assert course["quality_points"] == 3.5
        assert course["score"] == -3.0

        gpa = client.get("/api/gpa").json()
        assert gpa["overall_gpa"] == 3.5
        assert gpa["overall_score"] == -3.0
    finally:
        teardown()


def test_college_term_wgpa_uses_class_weight_tag(tmp_path):
    client = make_client(tmp_path)
    try:
        settings = client.patch(
            "/api/settings",
            json={
                "gradebook_type": "college",
                "gpa_weight_tags": [
                    {"id": "unweighted", "name": "Unweighted", "boost": 0},
                    {"id": "weighted", "name": "Weighted", "boost": 0.5},
                ],
            },
        )
        assert settings.status_code == 200

        semester_id = client.get("/api/semesters").json()[0]["id"]
        course = client.post(
            "/api/courses",
            json={
                "semester_id": semester_id,
                "code": "ENG 101",
                "credits": 3,
                "gp_override": 3.0,
                "gpa_weight_tag": "weighted",
            },
        ).json()

        assert course["quality_points"] == 3.0
        assert course["gpa_weight_boost"] == 0.5

        client.post(
            "/api/courses",
            json={
                "semester_id": semester_id,
                "code": "ENG 102",
                "credits": 3,
                "gp_override": 4.333,
            },
        )

        term = client.get("/api/gpa").json()["terms"][0]
        assert term["term_gpa"] == pytest.approx((3.0 + 4.333) / 2)
        assert term["term_wgpa"] == pytest.approx((3.5 + 4.333) / 2)
        gpa = client.get("/api/gpa").json()
        assert gpa["overall_gpa"] == pytest.approx((3.0 + 4.333) / 2)
        assert gpa["weighted_overall_gpa"] == pytest.approx((3.5 + 4.333) / 2)
    finally:
        teardown()


def test_high_school_score_splits_academic_year_units_across_terms(tmp_path):
    client = make_client(tmp_path)
    try:
        client.patch(
            "/api/settings",
            json={"gradebook_type": "high_school", "gpa_basis": "classes"},
        )
        fall = client.post(
            "/api/semesters", json={"year": 2030, "season": "fall", "included": True}
        ).json()
        spring = client.post(
            "/api/semesters", json={"year": 2030, "season": "spring", "included": True}
        ).json()
        client.post(
            "/api/academic-years",
            json={"name": "2030-31", "semester_ids": [fall["id"], spring["id"]]},
        )

        for semester_id in [fall["id"], spring["id"]]:
            client.post(
                "/api/courses",
                json={
                    "semester_id": semester_id,
                    "code": "ENG 101",
                    "gp_override": 4.333,
                },
            )
        client.post(
            "/api/courses",
            json={"semester_id": fall["id"], "code": "ART 101", "gp_override": 4.333},
        )

        gpa = client.get("/api/gpa").json()
        terms = {term["id"]: term for term in gpa["terms"]}
        # Term scores are raw target-relative scores; unit shares apply only
        # to the overall period score.
        assert terms[fall["id"]]["term_score"] == 2.0
        assert terms[spring["id"]]["term_score"] == 1.0
        assert gpa["overall_score"] == 1.5
    finally:
        teardown()


def test_high_school_overall_score_uses_period_coverage_not_graded_terms(tmp_path):
    client = make_client(tmp_path)
    try:
        client.patch(
            "/api/settings",
            json={"gradebook_type": "high_school", "gpa_basis": "classes"},
        )
        terms = [
            client.post(
                "/api/semesters", json={"year": 2030 + index, "season": "fall", "included": True}
            ).json()
            for index in range(3)
        ]
        client.post(
            "/api/academic-years",
            json={"name": "Three-term period", "semester_ids": [term["id"] for term in terms]},
        )

        for index, term in enumerate(terms):
            client.post(
                "/api/courses",
                json={
                    "semester_id": term["id"],
                    "code": "ALG 101",
                    "gp_override": 3.667 if index < 2 else None,
                },
            )
        client.post(
            "/api/courses",
            json={"semester_id": terms[0]["id"], "code": "BIO 101", "gp_override": 3.333},
        )

        gpa = client.get("/api/gpa").json()

        # ALG 101 exists in all three terms, so its A- contributes one full
        # unit even though only two terms have grades. BIO 101 is B+ in one of
        # three terms, so it contributes -2 * 1/3.
        assert gpa["overall_score"] == pytest.approx(-1.6666666667)
    finally:
        teardown()


def test_high_school_final_override_does_not_change_term_grade(tmp_path):
    client = make_client(tmp_path)
    try:
        settings = client.patch(
            "/api/settings",
            json={"gradebook_type": "high_school", "gpa_basis": "classes"},
        )
        assert settings.status_code == 200
        fall = client.post(
            "/api/semesters", json={"year": 2030, "season": "fall", "included": True}
        ).json()
        spring = client.post(
            "/api/semesters", json={"year": 2031, "season": "spring", "included": True}
        ).json()
        client.post(
            "/api/academic-years",
            json={"name": "2030-31", "semester_ids": [fall["id"], spring["id"]]},
        )
        courses = [
            client.post(
                "/api/courses",
                json={"semester_id": semester["id"], "code": "ENG 101", "gp_override": 3.0},
            ).json()
            for semester in (fall, spring)
        ]

        for course in courses:
            updated = client.patch(
                f"/api/courses/{course['id']}",
                json={"final_gp_override": 4.333},
            )
            assert updated.status_code == 200
            assert updated.json()["gp_override"] == 3.0
            assert updated.json()["final_gp_override"] == 4.333

        gpa = client.get("/api/gpa").json()
        terms = {term["id"]: term for term in gpa["terms"]}
        assert terms[fall["id"]]["term_gpa"] == 3.0
        assert terms[spring["id"]]["term_gpa"] == 3.0
        assert gpa["overall_gpa"] == pytest.approx(4.333)

        # Clearing the final override restores the natural rollup. Changing a
        # term override then changes the rollup input without changing any
        # unrelated term row.
        for course in courses:
            assert client.patch(
                f"/api/courses/{course['id']}",
                json={"final_gp_override": None},
            ).status_code == 200
        assert client.get("/api/gpa").json()["overall_gpa"] == pytest.approx(3.0)
        assert client.patch(
            f"/api/courses/{courses[1]['id']}",
            json={"gp_override": 4.333},
        ).status_code == 200
        gpa = client.get("/api/gpa").json()
        terms = {term["id"]: term for term in gpa["terms"]}
        assert terms[fall["id"]]["term_gpa"] == 3.0
        assert terms[spring["id"]]["term_gpa"] == pytest.approx(4.333)
        assert gpa["overall_gpa"] == pytest.approx(4.333)
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
        custom = client.put(f"/api/courses/{first['id']}/scale", json={"rows": custom_rows, "minimum_passing_letter": "C-"}).json()
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


def test_legacy_aggregation_is_rejected(tmp_path):
    client = make_client(tmp_path)
    try:
        sem_id = client.get("/api/semesters").json()[0]["id"]
        cid = client.post("/api/courses", json={"semester_id": sem_id, "code": "CSC 101", "credits": 3}).json()["id"]
        for aggregation in ("drop_lowest", "average_plus_bonus", "replace_min_with"):
            response = client.post(
                "/api/categories",
                json={"course_id": cid, "name": aggregation, "weight": 0.2, "aggregation": aggregation},
            )
            assert response.status_code == 400
        rejected = client.patch(
            "/api/categories/999999",
            json={"drop_count": -1},
        )
        assert rejected.status_code == 422
    finally:
        teardown()


def test_transfer_semester_and_level_stats(tmp_path):
    client = make_client(tmp_path)
    try:
        created = client.post("/api/semesters", json={"year": 2024, "season": "transfer", "included": True})
        assert created.status_code == 200
        assert created.json()["name"] == "2024 Transfer"
        assert created.json()["season"] == "transfer"
        arbitrary = client.post("/api/semesters", json={"year": 2024, "season": "winter"})
        assert arbitrary.status_code == 200
        custom = client.post("/api/semesters", json={"year": 2024, "season": "Term 2"})
        assert custom.status_code == 200
        assert custom.json()["season"] == "term 2"
        renamed = client.patch(f"/api/semesters/{custom.json()['id']}", json={"season": "Term 3"})
        assert renamed.status_code == 200
        assert renamed.json()["season"] == "term 3"
        assert "transfer" in client.get("/api/meta").json()["seasons"]

        sid = created.json()["id"]
        client.post("/api/courses", json={"semester_id": sid, "code": "MAE 310", "credits": 3, "gp_override": 4.0})
        client.post("/api/courses", json={"semester_id": sid, "code": "MATH 2310", "credits": 4, "gp_override": 3.0})
        client.post("/api/courses", json={"semester_id": sid, "code": "Seminar", "credits": 1, "gp_override": 4.0})
        gpa = client.get("/api/gpa").json()
        levels = {row["level"]: row for row in gpa["level_stats"]}
        assert levels["300"]["courses"] == 1
        assert levels["300"]["credits"] == 3
        assert levels["300"]["score"] == 0
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
            json={"test_category_ids": [ids["Tests"]], "exam_category_id": ids["Final"]},
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


def test_snapshot_skips_ungraded_and_edits_points(tmp_path):
    client = make_client(tmp_path)
    try:
        sem_id = client.get("/api/semesters").json()[0]["id"]
        graded = client.post(
            "/api/courses",
            json={"semester_id": sem_id, "code": "CSC 101", "credits": 3},
        ).json()
        empty = client.post(
            "/api/courses",
            json={"semester_id": sem_id, "code": "CSC 202", "credits": 3},
        ).json()
        cat = client.post(
            "/api/categories",
            json={"course_id": graded["id"], "name": "Exams", "weight": 1, "aggregation": "average"},
        ).json()
        client.post("/api/assignments", json={"category_id": cat["id"], "name": "Midterm", "score": "90"})
        client.post(
            "/api/categories",
            json={"course_id": empty["id"], "name": "Exams", "weight": 1, "aggregation": "average"},
        )

        recorded = client.post(f"/api/semesters/{sem_id}/snapshots")
        snap = recorded.json()
        assert recorded.status_code == 200
        codes = [row["code"] for row in snap["courses"]]
        assert codes == ["CSC 101"]
        assert snap["courses"][0]["percent"] == 90

        other = client.post(
            "/api/courses",
            json={"semester_id": sem_id, "code": "CSC 303", "credits": 3},
        ).json()
        other_cat = client.post(
            "/api/categories",
            json={"course_id": other["id"], "name": "Exams", "weight": 1, "aggregation": "average"},
        ).json()
        client.post("/api/assignments", json={"category_id": other_cat["id"], "name": "Midterm", "score": "80"})
        snap = client.post(f"/api/semesters/{sem_id}/snapshots").json()
        by_code = {row["code"]: row for row in snap["courses"]}
        assert set(by_code) == {"CSC 101", "CSC 303"}

        edited = client.patch(
            f"/api/semesters/{sem_id}/snapshots/{snap['id']}",
            json={"course_id": by_code["CSC 101"]["course_id"], "percent": 94.5},
        ).json()
        edited_codes = {row["code"]: row["percent"] for row in edited["courses"]}
        assert edited_codes["CSC 101"] == 94.5
        assert edited_codes["CSC 303"] == 80

        removed = client.request(
            "DELETE",
            f"/api/semesters/{sem_id}/snapshots",
            json={"course_points": [{"snapshot_id": snap["id"], "course_id": by_code["CSC 303"]["course_id"]}]},
        ).json()
        assert removed["deleted"] >= 1
        leftover = client.get(f"/api/semesters/{sem_id}/snapshots").json()
        assert len(leftover) == 1
        assert [row["code"] for row in leftover[0]["courses"]] == ["CSC 101"]
        assert leftover[0]["term_gpa"] is None
        assert leftover[0]["term_wgpa"] is None

        empty_sem = client.post("/api/semesters", json={"year": 2020, "season": "fall"}).json()
        client.post(
            "/api/courses",
            json={"semester_id": empty_sem["id"], "code": "CSC 404", "credits": 3},
        )
        none = client.post(f"/api/semesters/{empty_sem['id']}/snapshots")
        assert none.status_code == 400
        assert "No class grades" in none.json()["detail"]
    finally:
        teardown()


def test_deleting_course_removes_its_saved_progression_points(tmp_path):
    client = make_client(tmp_path)
    try:
        sem_id = client.get("/api/semesters").json()[0]["id"]
        courses = []
        for code, score in (("CSC 101", "90"), ("CSC 202", "80")):
            course = client.post(
                "/api/courses", json={"semester_id": sem_id, "code": code, "credits": 3}
            ).json()
            category = client.post(
                "/api/categories",
                json={"course_id": course["id"], "name": "Exams", "weight": 1, "aggregation": "average"},
            ).json()
            client.post(
                "/api/assignments",
                json={"category_id": category["id"], "name": "Exam", "score": score},
            )
            courses.append(course)

        snapshot = client.post(f"/api/semesters/{sem_id}/snapshots").json()
        assert {row["course_id"] for row in snapshot["courses"]} == {course["id"] for course in courses}

        deleted = client.delete(f"/api/courses/{courses[0]['id']}")
        assert deleted.status_code == 200
        remaining = client.get(f"/api/semesters/{sem_id}/snapshots").json()
        assert len(remaining) == 1
        assert [row["course_id"] for row in remaining[0]["courses"]] == [courses[1]["id"]]
    finally:
        teardown()


def test_deleting_class_point_removes_same_class_and_day_across_terms(tmp_path):
    client = make_client(tmp_path)
    try:
        semesters = [
            client.post(
                "/api/semesters",
                json={"year": year, "season": season, "included": True},
            ).json()
            for year, season in ((2030, "fall"), (2031, "spring"))
        ]

        def add_graded_course(semester_id, code, score):
            course = client.post(
                "/api/courses", json={"semester_id": semester_id, "code": code, "credits": 3}
            ).json()
            category = client.post(
                "/api/categories",
                json={"course_id": course["id"], "name": "Exam", "weight": 1, "aggregation": "average"},
            ).json()
            client.post(
                "/api/assignments",
                json={"category_id": category["id"], "name": "Exam", "score": score},
            )
            return course

        first_class = add_graded_course(semesters[0]["id"], "MATH 101", "90")
        add_graded_course(semesters[0]["id"], "SCI 101", "80")
        add_graded_course(semesters[1]["id"], "MATH 101", "85")
        add_graded_course(semesters[1]["id"], "SCI 202", "75")

        first_snapshot = client.post(f"/api/semesters/{semesters[0]['id']}/snapshots").json()
        second_snapshot = client.post(f"/api/semesters/{semesters[1]['id']}/snapshots").json()
        assert first_snapshot["recorded_at"][:10] == second_snapshot["recorded_at"][:10]

        deleted = client.request(
            "DELETE",
            f"/api/semesters/{semesters[0]['id']}/snapshots",
            json={
                "course_points": [
                    {"snapshot_id": first_snapshot["id"], "course_id": first_class["id"]}
                ]
            },
        )
        assert deleted.status_code == 200

        first_remaining = client.get(f"/api/semesters/{semesters[0]['id']}/snapshots").json()[0]
        second_remaining = client.get(f"/api/semesters/{semesters[1]['id']}/snapshots").json()[0]
        assert [row["code"] for row in first_remaining["courses"]] == ["SCI 101"]
        assert [row["code"] for row in second_remaining["courses"]] == ["SCI 202"]
        assert first_remaining["term_gpa"] is None
        assert first_remaining["term_wgpa"] is None
        assert second_remaining["term_gpa"] is None
        assert second_remaining["term_wgpa"] is None
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


def test_grading_mode_points_based(tmp_path):
    client = make_client(tmp_path)
    try:
        sem_id = client.get("/api/semesters").json()[0]["id"]
        course = client.post(
            "/api/courses",
            json={"semester_id": sem_id, "code": "ENG 331", "credits": 3},
        ).json()
        cid = course["id"]
        assert course["grading_mode"] == "weighted"
        hw = client.post(
            "/api/categories",
            json={"course_id": cid, "name": "HW", "weight": 0.5, "aggregation": "average"},
        ).json()
        final = client.post(
            "/api/categories",
            json={"course_id": cid, "name": "Final", "weight": 0.5, "aggregation": "average"},
        ).json()
        client.post("/api/assignments", json={"category_id": hw["id"], "score": "10/10"})
        client.post("/api/assignments", json={"category_id": final["id"], "score": "0/90"})

        weighted = client.get(f"/api/courses/{cid}").json()
        assert abs(weighted["percent"] - 50.0) < 1e-6

        points = client.patch(f"/api/courses/{cid}", json={"grading_mode": "points"}).json()
        assert points["grading_mode"] == "points"
        assert abs(points["percent"] - 10.0) < 1e-6
        assert points["dynamic_weighting_enabled"] is False

        denied = client.patch(
            f"/api/courses/{cid}",
            json={"dynamic_weighting_enabled": True},
        ).json()
        assert denied["dynamic_weighting_enabled"] is False

        bad = client.patch(f"/api/courses/{cid}", json={"grading_mode": "curve"})
        assert bad.status_code == 400
    finally:
        teardown()


def test_reorder_categories(tmp_path):
    client = make_client(tmp_path)
    try:
        sem_id = client.get("/api/semesters").json()[0]["id"]
        course = client.post(
            "/api/courses",
            json={"semester_id": sem_id, "code": "ENG 331", "credits": 3},
        ).json()
        cid = course["id"]
        client.post("/api/categories", json={"course_id": cid, "name": "Project 1", "weight": 0.3})
        client.post("/api/categories", json={"course_id": cid, "name": "Project 2", "weight": 0.3})
        client.post("/api/categories", json={"course_id": cid, "name": "Project 3", "weight": 0.4})
        names = [c["name"] for c in client.get(f"/api/courses/{cid}").json()["categories"]]
        assert names == ["Project 1", "Project 2", "Project 3"]
        ids = [c["id"] for c in client.get(f"/api/courses/{cid}").json()["categories"]]
        reordered = client.put(
            f"/api/courses/{cid}/categories/order",
            json={"category_ids": [ids[2], ids[0], ids[1]]},
        ).json()
        assert [c["name"] for c in reordered["categories"]] == ["Project 3", "Project 1", "Project 2"]
        assert [c["sort_order"] for c in reordered["categories"]] == [0, 1, 2]
        missing = client.put(
            f"/api/courses/{cid}/categories/order",
            json={"category_ids": ids[:2]},
        )
        assert missing.status_code == 400
    finally:
        teardown()
