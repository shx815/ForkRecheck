"""Independently authored recheck cases against the historical verl scorer."""

import importlib.util
import pathlib
import sys


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


root = pathlib.Path.cwd()
scorer = load(root / "verl/utils/reward_score/math_dapo.py", "fork_recheck_math")
mode = sys.argv[1]

if mode == "regression":
    cases = [
        (r"x=2,\text{and } y=3", r"x=1,\text{and } y=3", False, "review-example"),
        (r"$x=2$,\text{and } y_{1}=3", r"$x=1$,\text{and } y_{1}=3", False, "combined-braced"),
        (r"$x=2$,\text{and } \beta=3", r"$x=1$,\text{and } \beta=3", False, "combined-greek"),
        (r"$x=1$,\text{and } y_{1}=3", r"$x=1$,\text{and } y_{1}=3", True, "combined-positive"),
    ]
    collapsed = []
    for answer, gold, expected, label in cases:
        result = scorer.compute_score("Answer: " + answer, gold)
        if result["acc"] is expected and result["score"] == (1.0 if expected else -1.0):
            continue
        if not expected and result["acc"] is True and result["score"] == 1.0:
            collapsed.append(label)
            continue
        raise AssertionError((label, result, expected))
    if collapsed:
        print("False positives:", ", ".join(collapsed))
        print("FORK_RECHECK:assignment-collapse")
        sys.exit(42)
    print("4 regression cases passed")
    print("FORK_RECHECK:regression-pass")
elif mode == "related":
    # Run the original parametrized cases without importing verl's training package.
    import types

    fake_pytest = types.ModuleType("pytest")
    captured = []

    def parametrize(names, values):
        assert names == "answer, ground_truth, expected_correct"
        captured.extend(values)
        return lambda decorated: decorated

    fake_pytest.mark = types.SimpleNamespace(parametrize=parametrize)
    sys.modules["pytest"] = fake_pytest
    sys.modules["verl.utils.reward_score.math_dapo"] = scorer
    original = load(root / "tests/utils/reward_score/test_math_dapo_assignments_on_cpu.py", "fork_recheck_original")
    assert len(captured) == 16, "expected all historical parametrized cases"
    for case in captured:
        original.test_compute_score_assignments(*case)
    print(f"{len(captured)} historical case functions passed")
    print("FORK_RECHECK:related-pass")
else:
    raise SystemExit("unknown target")
