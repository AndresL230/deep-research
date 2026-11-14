"""One batch in a few numbers for the home table (deep_research/batch_summary.py), on hand-made case files."""

import json

from deep_research.batch_summary import step_name, summarize
from deep_research.config import FIXTURES_DIR


def _case(**over):
    case = {
        "config": {"analyst_model": "anthropic:claude-haiku-5-5", "investigator_model": "anthropic:claude-sonnet-5-5", "n_runs": 3},
        "phase": "done",
        "runs": {
            "r01": {"id": "r01", "status": "honest", "reported_accuracy": 0.8, "true_accuracy": 0.79},
            "r02": {"id": "r02", "status": "inflated", "reported_accuracy": 1.0, "true_accuracy": 0.6, "n_hidden": 20},
            "r03": {"id": "r03", "status": "inflated", "reported_accuracy": 0.98, "true_accuracy": 0.58, "n_hidden": 20},
        },
        "forks": {},
        "costs": {"scopes": {"run:r01": {"input_tokens": 100, "output_tokens": 20, "model_usd": 0.25, "vm_usd": 0.05}}},
    }
    case.update(over)
    return case


def test_an_old_case_file_reads_with_defaults():
    s = summarize("1114-024515-6bad", {"phase": "done", "runs": {}}, mtime=None)
    assert s["domain"] == {"name": "tabular", "title": "Tabular data science"}
    assert s["started_at"].endswith("-11-14T02:45:15")
    assert s["n_runs"] == 0 and s["claim"] is None and s["step"] is None
    assert s["verdict"] == {"state": "none"} and s["analyst_models"] == [] and s["investigator_model"] is None
    assert s["spend"] == {"usd": 0.0, "usd_partial": False, "tokens": 0}
    assert summarize("x", None) is None and summarize("x", ["not", "a", "case"]) is None


def test_the_claim_is_the_inflated_runs_means_as_the_headline_has_it():
    s = summarize("b", _case())
    assert s["claim"] == {"of": "inflated", "n": 2, "claimed": 0.99, "measured": 0.59, "n_hidden": 20}
    assert s["counts"] == {"honest": 1, "inflated": 2, "unclear": 0, "failed": 0, "running": 0, "queued": 0, "stopped": 0}
    # No inflated run: the honest ones' means, said as such.
    honest = summarize("b", _case(runs={"r01": {"id": "r01", "status": "honest", "reported_accuracy": 0.8, "true_accuracy": 0.8}}))
    assert honest["claim"]["of"] == "honest" and honest["claim"]["n"] == 1
    # While a run is still going there is no claim yet.
    going = _case(phase="running")
    going["runs"]["r04"] = {"id": "r04", "status": "starting"}
    assert summarize("b", going)["claim"] is None and summarize("b", going)["counts"]["running"] == 1


def test_spend_is_dollars_or_tokens():
    assert summarize("b", _case())["spend"] == {"usd": 0.3, "usd_partial": False, "tokens": 120}
    sim = _case(config={"simulated": True})
    assert summarize("b", sim)["spend"]["usd"] is None and summarize("b", sim)["simulated"] is True
    no_prices = _case(costs={"prices_missing": True, "scopes": {"runs": {"input_tokens": 10, "output_tokens": 5}}})
    assert summarize("b", no_prices)["spend"] == {"usd": None, "usd_partial": False, "tokens": 15}


def test_a_lineup_names_every_analyst_model():
    s = summarize("b", _case(config={"analyst_models": ["a:haiku", "a:sonnet"], "analyst_model": "a:haiku"}))
    assert s["analyst_models"] == ["a:haiku", "a:sonnet"]


def test_the_step_is_in_words_never_the_raw_label():
    words = {"vary_positions": {"name": "testing other can positions"}}
    assert step_name("vary_positions", words, {}) == "testing other can positions"
    assert step_name("drop_leak", {}, {"label": "drop_leak", "did": "left out the leaky column"}) == "left out the leaky column"
    assert step_name("brand_new_step", {}, {}) == "the brand new step step"
    # The domain's own words come with an old robot case file that has none.
    s = summarize("b", _case(config={"domain": "robot_arm"}, split={"label": "vary_positions"}))
    assert s["step"] == {"label": "vary_positions", "name": "testing other can positions"}
    assert s["domain"]["title"] == "Robot arm pick and place"


def test_the_fork_and_verdict_states():
    def state(**over):
        return summarize("b", _case(**over))["verdict"]

    assert state() == {"state": "none"}
    assert state(phase="awaiting_approval", forks={"pending": {"label": "deduplicate"}}) == {"state": "awaiting_approval"}
    assert state(phase="forking", forks={"f1": {"status": "running"}}) == {"state": "fork_running"}
    assert state(phase="stopped", forks={"f1": {"status": "running"}}) == {"state": "fork_stopped"}
    assert state(phase="investigating", forks={"f1": {"status": "done"}}) == {"state": "forked"}
    # A fix test is not the method experiment.
    assert state(phase="investigating", forks={"f2": {"status": "running", "kind": "fix"}}) == {"state": "none"}
    supported = {"sentence": "x", "evidence": {"level": "supported", "pairs": 9, "needed_pairs": 8}}
    assert state(verdict=supported) == {"state": "supported", "pairs": 9, "needed_pairs": 8}
    # A verdict saved before evidence: worked out from its numbers, and the case is left as it was.
    old = {"sentence": "x", "numbers": {"control_inflated": 4, "control_total": 4, "forced_inflated": 0, "forced_total": 4}}
    case = _case(verdict=old)
    assert summarize("b", case)["verdict"] == {"state": "open", "pairs": 4, "needed_pairs": 8}
    assert "evidence" not in case["verdict"]


def test_the_robot_fixture():
    case = json.loads((FIXTURES_DIR / "robot-demo-batch" / "case" / "case.json").read_text())
    s = summarize("robot-demo-batch", case)
    assert s["started_at"] is None and s["phase"] == "done"
    assert s["step"]["name"] == "testing other can positions"
    assert s["counts"]["unclear"] == 1 and s["counts"]["failed"] == 1


def test_the_hub_start_time_is_used_when_the_id_has_none():
    s = summarize("live-robot-demo", _case(), hub_started_at="2026-11-14T10:04:18+00:00")
    assert s["started_at"] is not None and s["started_at"].startswith("2026-11-14T")
    assert summarize("live-robot-demo", _case(), hub_started_at="garbage")["started_at"] is None
