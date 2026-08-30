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
