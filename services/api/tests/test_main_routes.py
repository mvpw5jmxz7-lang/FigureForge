"""Response serialization in `main.py` — never exercised by any other test.

Every other test in this suite calls the underlying `compute_*`/`run_test`
function directly, so `main.py`'s own response-building code (the layer that
maps a Python dataclass onto the JSON `BaseModel` the client actually reads)
had never been executed. That is exactly where a real bug lived: several
response fields were built as `_sanitize(value) or fallback`, and Python's
`or` treats a legitimate `0.0` as falsy — silently replacing a maximally
significant p-value or q-value (a very common, entirely valid result) with
the fallback meant only for NaN/Infinity. `_sanitize_or` is the fix; these
tests hit the real routes with data engineered to produce an exact `0.0` and
confirm it survives the response, which no test calling `compute_*`/
`run_test` directly could ever catch.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from figureforge.main import app

client = TestClient(app)


class TestSanitizeOr:
    def test_analyze_reports_an_exact_zero_p_value(self):
        # Zero variance in both groups with a real difference: a t-statistic
        # of infinity, and `scipy.stats.t.sf(inf, df)` is exactly 0.0 — not
        # NaN, so this does not take the existing zero-variance special case
        # and instead exercises the ordinary numeric path.
        response = client.post(
            "/analyze",
            json={
                "test": "ttest-independent",
                "groups": [
                    {"name": "A", "values": [1.0, 1.0, 1.0]},
                    {"name": "B", "values": [100.0, 100.0, 100.0]},
                ],
            },
        )
        assert response.status_code == 200
        comparison = response.json()["comparisons"][0]
        assert comparison["p"] == 0.0
        assert comparison["pAdjusted"] == 0.0

    def test_volcano_test_reports_an_exact_zero_p_and_q_value(self):
        # Same zero-variance-within-group construction, now through the SAM
        # permutation route: a clean 3v3 split with no within-group noise at
        # all is exactly the well-separated case reported as producing a
        # p/q of 0.0 in practice.
        response = client.post(
            "/volcano-test",
            json={
                "rowLabels": ["GeneA", "GeneB", "GeneC", "GeneD"],
                "values": [
                    [1.0, 1.0, 1.0, 100.0, 100.0, 100.0],
                    [1.0, 1.0, 1.0, 100.0, 100.0, 100.0],
                    [1.0, 1.0, 1.0, 100.0, 100.0, 100.0],
                    [1.0, 1.0, 1.0, 100.0, 100.0, 100.0],
                ],
                "mode": "two-sample",
                "groupAIndices": [0, 1, 2],
                "groupBIndices": [3, 4, 5],
                "s0": 0.1,
                "fdrPercent": 5.0,
            },
        )
        assert response.status_code == 200
        rows = response.json()["rows"]
        assert len(rows) == 4
        for row in rows:
            assert row["pValue"] == 0.0
            assert row["qValue"] == 0.0
            assert row["category"] == "up"


class TestFitSerialization:
    """The fitted line has to survive `main.py` as well as be computed.

    `AnalyzeResponse.fit` is a nested model, unlike every field the tests above
    cover, so a missing entry in `_fit_out` would drop a term silently rather
    than fail — the response would still validate and the client would draw a
    band from an incomplete record.
    """

    ANSCOMBE_X = [10.0, 8.0, 13.0, 9.0, 11.0, 14.0, 6.0, 4.0, 12.0, 7.0, 5.0]
    ANSCOMBE_Y = [8.04, 6.95, 7.58, 8.81, 8.33, 9.96, 7.24, 4.26, 10.84, 4.82, 5.68]

    def _analyze(self, test: str) -> dict:
        response = client.post(
            "/analyze",
            json={
                "test": test,
                "groups": [{"name": "y", "values": self.ANSCOMBE_Y}],
                "x": {"name": "x", "values": self.ANSCOMBE_X},
            },
        )
        assert response.status_code == 200
        return response.json()

    def test_regression_fit_reaches_the_wire_whole(self):
        fit = self._analyze("linear-regression")["fit"]
        assert fit is not None
        # Every term the client needs to evaluate the line and either band.
        assert set(fit) == {
            "slope", "intercept", "n", "meanX", "sumSquaredDevX",
            "residualSe", "tMultiplier", "confidenceLevel", "xMin", "xMax",
        }
        assert fit["intercept"] == pytest.approx(3.0001, abs=1e-3)
        assert fit["sumSquaredDevX"] == pytest.approx(110.0, abs=1e-9)
        assert fit["n"] == 11

    def test_pearson_carries_a_fit_and_spearman_does_not(self):
        assert self._analyze("pearson")["fit"] is not None
        assert self._analyze("spearman")["fit"] is None

    def test_a_test_that_fits_no_line_reports_null(self):
        response = client.post(
            "/analyze",
            json={
                "test": "ttest-welch",
                "groups": [
                    {"name": "A", "values": [1.0, 2.0, 3.0]},
                    {"name": "B", "values": [4.0, 5.0, 6.0]},
                ],
            },
        )
        assert response.status_code == 200
        assert response.json()["fit"] is None


class TestDistributionTestsOverTheWire:
    """The route layer for round 50's four distribution tests.

    `/analyze` needed no change to accept them — `test` is an unvalidated
    `str` and `run_test` owns validation — so what is worth checking here is
    the half that *is* new: `pBound` reaching the client, and the refusals
    arriving as 422s rather than 500s. Neither is visible to a test that calls
    `run_test` directly, which is the same gap this module was written for.
    """

    FAR_A = [1.0, 2, 3, 4, 5, 6, 7, 8]
    FAR_B = [100.0, 101, 102, 103, 104, 105, 106, 107]

    def test_a_clamped_p_value_arrives_as_a_bound(self):
        response = client.post(
            "/analyze",
            json={
                "test": "anderson-darling",
                "groups": [
                    {"name": "A", "values": self.FAR_A},
                    {"name": "B", "values": self.FAR_B},
                ],
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["omnibus"]["pBound"] == "below"
        assert body["comparisons"][0]["pBound"] == "below"
        # And the sentence the author pastes says so too, rather than quoting
        # the clamp as though the test had named it.
        assert "P < 0.001" in body["methodsSentence"]

    def test_every_other_test_still_reports_no_bound(self):
        """The field is present and null, not absent — a client reading it
        unconditionally must not have to guess which tests carry it."""
        response = client.post(
            "/analyze",
            json={
                "test": "kolmogorov-smirnov",
                "groups": [
                    {"name": "A", "values": self.FAR_A},
                    {"name": "B", "values": self.FAR_B},
                ],
            },
        )
        assert response.status_code == 200
        assert response.json()["comparisons"][0]["pBound"] is None

    def test_the_gap_location_reaches_the_client(self):
        """Without this the ECDF marker has nothing to place itself against.

        Two samples that do not overlap at all: every value of A is below
        every value of B, so the maximum gap is D = 1 and it is attained at
        A's own largest value, with A's CDF the higher one there.
        """
        response = client.post(
            "/analyze",
            json={
                "test": "kolmogorov-smirnov",
                "groups": [
                    {"name": "A", "values": self.FAR_A},
                    {"name": "B", "values": self.FAR_B},
                ],
            },
        )
        assert response.status_code == 200
        comparison = response.json()["comparisons"][0]
        assert comparison["statistic"] == pytest.approx(1.0)
        assert comparison["statisticLocation"] == pytest.approx(8.0)
        assert comparison["statisticSign"] == 1

    def test_a_test_with_no_location_sends_null_rather_than_omitting_it(self):
        response = client.post(
            "/analyze",
            json={
                "test": "cramer-von-mises",
                "groups": [
                    {"name": "A", "values": self.FAR_A},
                    {"name": "B", "values": self.FAR_B},
                ],
            },
        )
        assert response.status_code == 200
        comparison = response.json()["comparisons"][0]
        assert comparison["statisticLocation"] is None
        assert comparison["statisticSign"] is None

    @pytest.mark.parametrize(
        ("test", "groups", "fragment"),
        [
            (
                "epps-singleton",
                [{"name": "A", "values": [1.0, 2, 3, 4]}, {"name": "B", "values": [5.0, 6, 7, 8]}],
                "at least 5 observations",
            ),
            (
                "anderson-darling",
                [{"name": "A", "values": [1.0]}, {"name": "B", "values": [1.0, 2, 3]}],
                "at least two observations",
            ),
            (
                "anderson-darling",
                [{"name": "A", "values": [5.0] * 5}, {"name": "B", "values": [5.0] * 5}],
                "no distribution to compare",
            ),
            (
                "cramer-von-mises",
                [{"name": "A", "values": [1.0, 2, 3]}, {"name": "B", "values": [4.0, 5, 6]}],
                "two-sided",
            ),
        ],
    )
    def test_a_refused_input_is_a_422_with_a_readable_reason(self, test, groups, fragment):
        """Not a 500, which is what an unguarded SciPy exception would give.

        The Epps-Singleton case is the one that matters most: unguarded it
        does not raise at all — it returns NaN, and `_sanitize_or` turns that
        into p = 1.0, so the panel would report a confident null result on two
        samples that do not overlap. Verified by removing the guard and
        watching the route answer 200 with exactly that.
        """
        body = {"test": test, "groups": groups}
        if fragment == "two-sided":
            body["alternative"] = "less"
        response = client.post("/analyze", json=body)
        assert response.status_code == 422
        assert fragment in response.json()["detail"]
