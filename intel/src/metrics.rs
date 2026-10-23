//! Ranking and classification metrics used by `intel-train`.

/// Fraction of cases whose true label is within the first k of the ranking.
pub fn top_k(cases: &[(usize, Vec<usize>)], k: usize) -> f32 {
    if cases.is_empty() {
        return 0.0;
    }
    let hit = cases.iter().filter(|(y, r)| r.iter().take(k).any(|p| p == y)).count();
    hit as f32 / cases.len() as f32
}

/// Macro-averaged F1 over the classes that occur in `y_true` or `y_pred`.
pub fn macro_f1(y_true: &[usize], y_pred: &[usize], n_classes: usize) -> f32 {
    let mut f1s = vec![];
    for k in 0..n_classes {
        let tp = y_true.iter().zip(y_pred).filter(|(t, p)| **t == k && **p == k).count() as f32;
        let fp = y_true.iter().zip(y_pred).filter(|(t, p)| **t != k && **p == k).count() as f32;
        let fn_ = y_true.iter().zip(y_pred).filter(|(t, p)| **t == k && **p != k).count() as f32;
        if tp + fp + fn_ == 0.0 {
            continue;
        }
        let prec = if tp + fp > 0.0 { tp / (tp + fp) } else { 0.0 };
        let rec = if tp + fn_ > 0.0 { tp / (tp + fn_) } else { 0.0 };
        f1s.push(if prec + rec > 0.0 { 2.0 * prec * rec / (prec + rec) } else { 0.0 });
    }
    if f1s.is_empty() {
        0.0
    } else {
        f1s.iter().sum::<f32>() / f1s.len() as f32
    }
}

pub fn accuracy(y_true: &[usize], y_pred: &[usize]) -> f32 {
    if y_true.is_empty() {
        return 0.0;
    }
    y_true.iter().zip(y_pred).filter(|(a, b)| a == b).count() as f32 / y_true.len() as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metrics_basics() {
        let cases = vec![(1, vec![1, 2]), (2, vec![1, 2]), (3, vec![1, 2])];
        assert!((top_k(&cases, 1) - 1.0 / 3.0).abs() < 1e-6);
        assert!((top_k(&cases, 2) - 2.0 / 3.0).abs() < 1e-6);
        assert!((macro_f1(&[0, 1], &[0, 1], 2) - 1.0).abs() < 1e-6);
        assert!((accuracy(&[0, 1, 1], &[0, 0, 1]) - 2.0 / 3.0).abs() < 1e-6);
    }
}
