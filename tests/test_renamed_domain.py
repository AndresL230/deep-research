"""A push recovery batch saved while its domain was still called "humanoid" reads as "humanoid_push" today.

The strike domain took the name "humanoid" after push recovery was renamed, so without this an old push batch would be
read as a strike batch: the wrong screens, the wrong summary, the wrong domain when it is reopened.
"""

from __future__ import annotations

import copy

from deep_research.batch_summary import summarize
from deep_research.case_file import current_domain, with_evidence


def _case(domain: str, title: str) -> dict:
    return {
        "config": {"domain": domain, "domain_info": {"name": domain, "title": title, "visual": "motion"}},
        "runs": {"r01": {"id": "r01", "status": "honest", "reported_accuracy": 0.9, "true_accuracy": 0.9}},
        "phase": "done",
    }


def test_an_old_push_batch_gets_its_name_today():
    case = current_domain(_case("humanoid", "Humanoid push recovery"))
    assert case["config"]["domain"] == "humanoid_push"
    assert case["config"]["domain_info"]["name"] == "humanoid_push"
    # Nothing else it recorded changes.
    assert case["config"]["domain_info"]["title"] == "Humanoid push recovery"
    assert case["runs"]["r01"]["status"] == "honest"


def test_a_strike_batch_and_every_other_domain_are_left_alone():
    for domain, title in [("humanoid", "Humanoid punch and kick"), ("humanoid_push", "Humanoid push recovery"),
                          ("robot_arm", "Robot arm pick and place"), ("tabular", "Tabular data science")]:
        case = _case(domain, title)
        before = copy.deepcopy(case)
        assert current_domain(case) == before


def test_a_case_file_with_no_domain_info_or_no_config_is_left_alone():
    assert current_domain({"config": {"domain": "humanoid"}}) == {"config": {"domain": "humanoid"}}
    assert current_domain({"runs": {}}) == {"runs": {}}


def test_every_reader_of_a_saved_case_file_sees_the_name_today():
    # The case route, reopening a batch and more pairs all read saved case files through with_evidence.
    assert with_evidence(_case("humanoid", "Humanoid push recovery"))["config"]["domain"] == "humanoid_push"
    # The home table's summary (local and hub batches) names the domain it is today.
    summary = summarize("1114-194740-a691", _case("humanoid", "Humanoid push recovery"))
    assert summary is not None
    assert summary["domain"]["name"] == "humanoid_push"
