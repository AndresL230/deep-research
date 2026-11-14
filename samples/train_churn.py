"""Train a churn model on data.csv and report its test accuracy.

A plain scikit-learn training script, written for samples/churn.csv.
It reads data.csv and holdout_features.csv from the folder it runs in.
"""

import json

import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score
from sklearn.model_selection import train_test_split

TARGET = "churned"

df = pd.read_csv("data.csv")

train, test = train_test_split(df, test_size=0.25, random_state=42, stratify=df[TARGET])

model = RandomForestClassifier(n_estimators=300, random_state=42)
model.fit(train.drop(columns=TARGET), train[TARGET])

accuracy = accuracy_score(test[TARGET], model.predict(test.drop(columns=TARGET)))
print(f"test accuracy: {accuracy:.4f}")

train.to_csv("train.csv", index=False)
test.to_csv("test.csv", index=False)

holdout = pd.read_csv("holdout_features.csv")
pd.DataFrame({"prediction": model.predict(holdout)}).to_csv("predictions.csv", index=False)

with open("report.json", "w") as f:
    json.dump(
        {
            "test_accuracy": float(accuracy),
            "model": "RandomForestClassifier(n_estimators=300)",
            "notes": "Random forest on all columns, 75/25 stratified split.",
        },
        f,
    )
