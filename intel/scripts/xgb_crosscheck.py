"""Dev-only cross-check: the Rust booster vs real XGBoost on the same data.

    cd intel
    uv run --no-project --with xgboost --with numpy python scripts/xgb_crosscheck.py models

Reads the rows `intel-train` exported (models/data_train.csv, data_test.csv),
trains real `xgboost` one-vs-rest with the SAME hyper-parameters as the Rust
booster (binary:logistic, hist, 32 bins, depth 4, eta 0.2, lambda 1, gamma 0,
60 rounds), and reports how far apart they are on the held-out scenarios:

  * top-1 within the rules candidate set (the ranking task in production)
  * real-choice top-1 (cases with 2+ candidates: the only ones where order matters)
  * macro-F1 of that top-1 over the causes
  * top-1 agreement between the two implementations

Not used at runtime and not a dependency of anything. The labels are
synthetic and rule-derived, so this compares two implementations of the same
learner -- it says nothing about real students.
"""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

import numpy as np
import xgboost as xgb

N_CLASSES = 22


def load(path: Path):
    X, y, cands, rules_top, rust_top = [], [], [], [], []
    with path.open(newline="") as f:
        for row in csv.DictReader(f):
            y.append(int(row["label"]))
            cands.append([int(c) for c in row["candidates"].split("|") if c])
            rules_top.append(int(row["rules_top"]))
            rust_top.append(int(row["rust_top"]))
            X.append([float(v) for k, v in row.items() if k.startswith("f")])
    return np.array(X, dtype=np.float32), np.array(y), cands, rules_top, rust_top


def macro_f1(y_true, y_pred):
    f1s = []
    for k in range(N_CLASSES):
        tp = sum(1 for t, p in zip(y_true, y_pred) if t == k and p == k)
        fp = sum(1 for t, p in zip(y_true, y_pred) if t != k and p == k)
        fn = sum(1 for t, p in zip(y_true, y_pred) if t == k and p != k)
        if tp + fp + fn == 0:
            continue
        prec = tp / (tp + fp) if tp + fp else 0.0
        rec = tp / (tp + fn) if tp + fn else 0.0
        f1s.append(2 * prec * rec / (prec + rec) if prec + rec else 0.0)
    return sum(f1s) / len(f1s) if f1s else 0.0


def main() -> int:
    d = Path(sys.argv[1] if len(sys.argv) > 1 else "models")
    Xtr, ytr, _, _, _ = load(d / "data_train.csv")
    Xte, yte, cands, rules_top, rust_top = load(d / "data_test.csv")

    params = {"objective": "binary:logistic", "tree_method": "hist", "max_bin": 32,
              "max_depth": 4, "eta": 0.2, "lambda": 1.0, "gamma": 0.0,
              "min_child_weight": 1.0, "subsample": 0.9, "colsample_bytree": 0.9,
              "seed": 7, "verbosity": 0}
    margins = np.full((len(yte), N_CLASSES), -np.inf)
    dte = xgb.DMatrix(Xte)
    for k in range(N_CLASSES):
        yk = (ytr == k).astype(np.float32)
        if yk.sum() == 0:
            continue
        m = xgb.train(params, xgb.DMatrix(Xtr, label=yk), num_boost_round=60)
        margins[:, k] = m.predict(dte, output_margin=True)

    xgb_top = [max(c, key=lambda k: margins[i, k]) for i, c in enumerate(cands)]
    multi = [i for i, c in enumerate(cands) if len(c) > 1]

    def top1(pred, idx=None):
        idx = range(len(yte)) if idx is None else idx
        idx = list(idx)
        return sum(1 for i in idx if pred[i] == yte[i]) / max(1, len(idx))

    report = {
        "rows_train": int(len(ytr)), "rows_test": int(len(yte)), "real_choice_cases": len(multi),
        "top1": {"rules": top1(rules_top), "rust_booster": top1(rust_top), "xgboost": top1(xgb_top)},
        "real_choice_top1": {"rules": top1(rules_top, multi), "rust_booster": top1(rust_top, multi),
                             "xgboost": top1(xgb_top, multi)},
        "macro_f1": {"rules": macro_f1(yte, rules_top), "rust_booster": macro_f1(yte, rust_top),
                     "xgboost": macro_f1(yte, xgb_top)},
        "top1_agreement_rust_vs_xgboost": sum(1 for a, b in zip(rust_top, xgb_top) if a == b) / len(yte),
        "real_choice_agreement_rust_vs_xgboost":
            sum(1 for i in multi if rust_top[i] == xgb_top[i]) / max(1, len(multi)),
        "xgboost_version": xgb.__version__,
        "caveat": "synthetic, rule-derived labels: compares two implementations of one learner",
    }
    (d / "xgb_crosscheck.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
