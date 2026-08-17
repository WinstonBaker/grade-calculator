from backend.engine import (
    AssignmentInput,
    CategoryInput,
    CourseInput,
    ScaleRow,
    avg_drop_x,
    category_percent,
    course_grade,
    effective_weight,
    exam_score_needed,
    fumble_delta,
    future_guess_delta,
    letter_from_percent,
    normalize_scale,
    overall_gpa_from_score,
    parse_score,
    points_ratio,
    project_from_exam,
    scale_rows_from_tuples,
    term_score,
    DEFAULT_SCALE,
    SCALE_PRESETS,
)


def P(earned, possible=100, bonus=False, name=""):
    return AssignmentInput(name=name, earned=earned, possible=possible, is_bonus=bonus)


def test_parse_score():
    assert parse_score("95") == (95.0, 100.0)
    assert parse_score("19/20") == (19.0, 20.0)
    assert parse_score("19,20") == (19.0, 20.0)
    assert parse_score("  ") == (None, None)


def test_avg_drop_x_ma407_hw():
    scores = [95, 90, 100, 80, 99.14, 100, 71, 100, 70.1]
    assert abs(avg_drop_x(scores, 1) - 91.8925) < 1e-6


def test_avg_drop_x_keeps_one():
    assert avg_drop_x([70], 5) == 70


def test_points_ratio():
    rows = [
        P(10, 10),
        P(49.5, 50),
        P(58, 60),
    ]
    expected = 100 * (10 + 49.5 + 58) / (10 + 50 + 60)
    assert abs(points_ratio(rows) - expected) < 1e-9


def test_replace_min_with_final():
    tests = CategoryInput(
        id=1,
        name="Tests",
        aggregation="replace_min_with",
        replace_with_category_id=2,
        assignments=[P(95), P(93)],
    )
    final = CategoryInput(id=2, name="Final", aggregation="average", assignments=[P(98.13)])
    pct = category_percent(tests, [tests, final])
    assert abs(pct - 96.565) < 1e-9


def test_average_plus_bonus():
    hw = CategoryInput(
        id=1,
        aggregation="average_plus_bonus",
        assignments=[
            P(100, bonus=True),
            P(99),
            P(96),
            P(96),
            P(100),
            P(99),
            P(94),
            P(98),
        ],
    )
    assert abs(category_percent(hw) - 111.714285714) < 1e-8


def test_weight_per_item():
    cat = CategoryInput(
        weight_per_item=0.15,
        assignments=[P(92), P(92), P(98)],
    )
    assert abs(effective_weight(cat) - 0.45) < 1e-12


def test_letter_from_percent_ma407():
    scale = [ScaleRow(*row) for row in DEFAULT_SCALE]
    letter, gp = letter_from_percent(86.05949167, scale)
    assert letter == "B"
    assert gp == 3.0
    letter, gp = letter_from_percent(104.457, scale)
    assert letter == "A+"
    assert gp == 4.333


def test_term_score_matches_sheet():
    assert term_score(3.0, 3, 4.0) == -9
    assert term_score(4.333, 3, 4.0) == 3
    assert term_score(4.333, 1, 4.0) == 1


def test_course_completed_only_and_bonus():
    course = CourseInput(
        code="DEMO",
        credits=3,
        bonus_points=5,
        categories=[
            CategoryInput(id=1, name="HW", weight=0.2, assignments=[P(100), P(90)]),
            CategoryInput(id=2, name="Tests", weight=0.5, assignments=[P(80)]),
            CategoryInput(id=3, name="Final", weight=0.3, assignments=[]),
        ],
    )
    result = course_grade(course, target_gp=4.0)
    # completed weights 0.2 and 0.5; percents 95 and 80
    raw = (0.2 * 95 + 0.5 * 80) / 0.7
    assert abs(result.percent - (raw + 5)) < 1e-9
    assert result.categories[2].percent is None


def test_what_if_needed_on_final():
    course = CourseInput(
        code="MAE 310",
        credits=3,
        categories=[
            CategoryInput(id=1, name="HW", weight=0.15, assignments=[P(111.7142857)]),
            CategoryInput(
                id=2,
                name="Tests",
                weight_per_item=0.15,
                aggregation="average_plus_bonus",
                assignments=[P(92), P(92), P(98), P(10, bonus=True), P(50, bonus=True)],
            ),
            CategoryInput(id=3, name="Final", weight=0.4, assignments=[]),
        ],
    )
    result = course_grade(course, target_gp=4.0)
    a_plus = next(w for w in result.what_if if w.letter == "A+" and w.category_name == "Final")
    # (97 - 16.757 - 51.3) / 0.4 ≈ 72.357
    assert abs(a_plus.needed - 72.357) < 0.02


def test_project_from_exam_hits_cutoff():
    course = CourseInput(
        code="MAE 310",
        credits=3,
        scale=[ScaleRow(*row) for row in DEFAULT_SCALE],
        categories=[
            CategoryInput(id=1, name="HW", weight=0.15, assignments=[P(111.7142857)]),
            CategoryInput(
                id=2,
                name="Tests",
                weight_per_item=0.15,
                aggregation="average_plus_bonus",
                assignments=[P(92), P(92), P(98), P(10, bonus=True), P(50, bonus=True)],
            ),
            CategoryInput(id=3, name="Final", weight=0.4, assignments=[]),
        ],
    )
    needed = exam_score_needed(course, 3, 97)
    assert abs(needed - 72.357) < 0.02
    projected = project_from_exam(course, 3, needed)
    assert abs(projected.percent - 97) < 1e-6
    assert projected.letter == "A+"


def test_project_from_exam_replace_min_with():
    course = CourseInput(
        code="X",
        credits=3,
        scale=[ScaleRow(*row) for row in DEFAULT_SCALE],
        categories=[
            CategoryInput(
                id=1,
                name="Tests",
                weight=0.5,
                aggregation="replace_min_with",
                replace_with_category_id=2,
                assignments=[P(70), P(90)],
            ),
            CategoryInput(id=2, name="Final", weight=0.5, assignments=[]),
        ],
    )
    # Final 94 replaces the 70: tests (90+94)/2 = 92; overall 0.5*92 + 0.5*94 = 93
    projected = project_from_exam(course, 2, 94)
    assert abs(projected.percent - 93) < 1e-9
    assert projected.letter == "A"
    needed = exam_score_needed(course, 2, 93)
    assert abs(needed - 94) < 0.05


def test_gp_override():
    course = CourseInput(
        code="X",
        credits=3,
        gp_override=4.333,
        categories=[CategoryInput(id=1, name="All", weight=1, assignments=[P(70)])],
    )
    result = course_grade(course)
    assert result.quality_points == 4.333
    assert result.letter == "A+"


def test_overall_gpa_from_score():
    # 44 score, 82 credits, target 4 → (44/3 + 4*82)/82 ≈ 4.17886
    gpa = overall_gpa_from_score(44, 82, 4.0)
    assert abs(gpa - 4.178861789) < 1e-8


def test_fumble_delta():
    assert fumble_delta(4.0, 4.333, 2, 4.0) == 2
    assert fumble_delta(3.667, 4.333, 3, 4.0) == 6
    assert fumble_delta(4.0, 4.333, 3, 4.0) == 3


def test_future_guess_delta():
    scale = [ScaleRow(*row) for row in DEFAULT_SCALE]
    delta, extra, _ = future_guess_delta({3: {"A+": 1}}, scale, 4.0)
    # one 3-credit A+: (4.333-4)*3 / 0.333 ≈ 3
    assert extra == 3
    assert delta == 3


def test_gpa_decimals_stay_distinct():
    rows = normalize_scale(
        [
            {"letter": "A+", "min_percent": 97, "quality_points": 4.333},
            {"letter": "A", "min_percent": 93, "quality_points": 4.33},
            {"letter": "A-", "min_percent": 90, "quality_points": 4.3},
            {"letter": "F", "min_percent": 0, "quality_points": 0},
        ]
    )
    qps = [qp for _, _, qp in rows]
    assert qps == [4.333, 4.33, 4.3, 0.0]
    assert len({4.3, 4.33, 4.333}) == 3


def test_normalize_scale_sorts_and_rejects_duplicates():
    rows = normalize_scale(
        [
            {"letter": "B", "min_percent": 80, "quality_points": 3},
            {"letter": "A", "min_percent": 90, "quality_points": 4},
            {"letter": "F", "min_percent": 0, "quality_points": 0},
        ]
    )
    assert [letter for letter, _, _ in rows] == ["A", "B", "F"]
    try:
        normalize_scale([("A", 90, 4), ("a", 80, 3)])
        assert False, "expected duplicate letter to fail"
    except ValueError as exc:
        assert "Duplicate" in str(exc)


def test_unc_scale_has_no_a_plus():
    scale = scale_rows_from_tuples(next(p["rows"] for p in SCALE_PRESETS if p["id"] == "unc"))
    letter, gp = letter_from_percent(98, scale)
    assert letter == "A"
    assert gp == 4.0
    letter, gp = letter_from_percent(91, scale)
    assert letter == "A-"
    assert gp == 3.7


def test_duke_aplus_same_gpa_as_a():
    scale = scale_rows_from_tuples(next(p["rows"] for p in SCALE_PRESETS if p["id"] == "duke"))
    plus_letter, plus_gp = letter_from_percent(99, scale)
    a_letter, a_gp = letter_from_percent(94, scale)
    assert plus_letter == "A+"
    assert a_letter == "A"
    assert plus_gp == a_gp == 4.0


def test_clemson_letters_only_scale():
    scale = scale_rows_from_tuples(next(p["rows"] for p in SCALE_PRESETS if p["id"] == "clemson"))
    assert letter_from_percent(89, scale) == ("B", 3.0)
    assert letter_from_percent(90, scale) == ("A", 4.0)


def test_cofc_has_d_minus():
    scale = scale_rows_from_tuples(next(p["rows"] for p in SCALE_PRESETS if p["id"] == "cofc"))
    letter, gp = letter_from_percent(60, scale)
    assert letter == "D-"
    assert gp == 0.7


def test_normalize_keeps_ncsu_thirds():
    rows = normalize_scale(DEFAULT_SCALE)
    plus = next(row for row in rows if row[0] == "A+")
    minus = next(row for row in rows if row[0] == "A-")
    assert plus[2] == 4.333
    assert minus[2] == 3.667
