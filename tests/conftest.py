"""Settings every test shares.

The tests never call a model or a VM, but `api.py` and `cli.py` load the repo's `.env` when imported. On a
machine whose `.env` turns LangSmith tracing on, that tracing then wraps the scripted agents in the offline
tests and makes their runs fail. `load_dotenv` never overrides a variable that is already set, so setting
these here, before any test module is imported, keeps tracing off for the whole session.
"""

import os

os.environ["LANGSMITH_TRACING"] = "false"
os.environ["LANGCHAIN_TRACING_V2"] = "false"
