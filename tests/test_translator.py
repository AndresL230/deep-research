from langchain_core.messages import AIMessageChunk, ToolMessage
from langgraph.types import Command

from server.translator import TurnTranslator, sse, tool_label


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def text_chunk(text: str, **kw) -> AIMessageChunk:
    return AIMessageChunk(content=[{"type": "text", "text": text, "index": 0}], id="m1", **kw)


META = {"langgraph_node": "model"}


def names(events):
    return [(n, d.get("state")) for n, d in events]


def test_thinking_run_then_done_before_first_text():
    clock = Clock()
    t = TurnTranslator(clock=clock)
    assert t.start() == [("thinking", {"state": "run"})]
    clock.now += 3.4
    events = t.feed("messages", (text_chunk("Hello"), META))
    assert events == [
        ("thinking", {"state": "done", "seconds": 3, "summary": ""}),
        ("text", {"delta": "Hello"}),
    ]
    # Only once.
    assert t.feed("messages", (text_chunk(" world"), META)) == [("text", {"delta": " world"})]


def test_text_deltas_ignore_tool_use_blocks_and_tool_messages():
    t = TurnTranslator()
    t.start()
    t.feed("messages", (text_chunk("a"), META))
    tool_use = AIMessageChunk(
        content=[{"type": "tool_use", "partial_json": '{"x":', "index": 1}], id="m1"
    )
    assert t.feed("messages", (tool_use, META)) == []
    assert t.feed("messages", (ToolMessage("out", tool_call_id="c1"), {"langgraph_node": "tools"})) == []
    assert t.feed("messages", (AIMessageChunk(content="plain", id="m2"), META)) == [
        ("text", {"delta": "plain"})
    ]


def test_tool_call_run_then_done_with_steps():
    clock = Clock()
    t = TurnTranslator(clock=clock)
    t.start()
    clock.now += 1
    started = t.feed(
        "tools",
        {"event": "tool-started", "tool_call_id": "c1", "tool_name": "execute",
         "input": {"command": "cd /home/daytona && python analyze.py"}},
    )
    assert started == [
        ("thinking", {"state": "done", "seconds": 1, "summary": ""}),
        ("activity", {"step": 1, "state": "run", "tool": "execute", "icon": "ci", "label": "Running analyze.py"}),
    ]
    out = ToolMessage("rows: 10\ncols: 4\n[Command succeeded with exit code 0]", tool_call_id="c1")
    done = t.feed("tools", {"event": "tool-finished", "tool_call_id": "c1", "output": out})
    assert done == [("activity", {"step": 1, "state": "done", "resultLine": "exit 0 · 2 lines of output"})]
    assert t.last_finished_tool == "execute"

    # Next tool gets step 2; icons follow the contract.
    run = t.feed("tools", {"event": "tool-started", "tool_call_id": "c2", "tool_name": "write_file",
                           "input": {"file_path": "/home/daytona/plot.py", "content": "a\nb\nc"}})
    assert run == [("activity", {"step": 2, "state": "run", "tool": "write_file", "icon": "docs", "label": "Writing plot.py"})]
    fin = t.feed("tools", {"event": "tool-finished", "tool_call_id": "c2",
                           "output": ToolMessage("Updated file /home/daytona/plot.py", tool_call_id="c2")})
    assert fin == [("activity", {"step": 2, "state": "done", "resultLine": "wrote 3 lines"})]
    assert t.last_finished_tool == "write_file"


def test_parallel_tools_keep_their_own_steps_and_errors():
    t = TurnTranslator()
    t.start()
    t.feed("tools", {"event": "tool-started", "tool_call_id": "a", "tool_name": "ls", "input": {"path": "/home/daytona/data"}})
    t.feed("tools", {"event": "tool-started", "tool_call_id": "b", "tool_name": "grep", "input": {"pattern": "region"}})
    err = t.feed("tools", {"event": "tool-error", "tool_call_id": "b", "message": "boom"})
    assert err == [("activity", {"step": 2, "state": "done", "resultLine": "boom"})]
    ok = t.feed("tools", {"event": "tool-finished", "tool_call_id": "a", "output": ToolMessage("/a.csv\n/b.csv", tool_call_id="a")})
    assert ok == [("activity", {"step": 1, "state": "done", "resultLine": "2 entries"})]
    # Unknown ids are ignored.
    assert t.feed("tools", {"event": "tool-finished", "tool_call_id": "zzz", "output": "x"}) == []


def test_write_todos_results_formatting():
    t = TurnTranslator()
    t.start()
    todos = [
        {"content": "Load the data", "status": "completed"},
        {"content": "Plot revenue", "status": "in_progress"},
        {"content": "Summarize", "status": "pending"},
    ]
    run = t.feed("tools", {"event": "tool-started", "tool_call_id": "t", "tool_name": "write_todos", "input": {"todos": todos}})
    assert run[-1] == ("activity", {"step": 1, "state": "run", "tool": "write_todos", "icon": "sprint", "label": "Planning"})
    output = Command(update={"todos": todos, "messages": [ToolMessage("Updated todo list", tool_call_id="t")]})
    done = t.feed("tools", {"event": "tool-finished", "tool_call_id": "t", "output": output})
    assert done == [(
        "activity",
        {"step": 1, "state": "done",
         "results": ["[x] Load the data", "[~] Plot revenue", "[ ] Summarize"],
         "resultLine": "1 of 3 done"},
    )]
    # A second write_todos is labelled as an update.
    again = t.feed("tools", {"event": "tool-started", "tool_call_id": "t2", "tool_name": "write_todos", "input": {"todos": todos}})
    assert again[-1][1]["label"] == "Updating the plan"


def test_image_block_and_done_with_tokens():
    t = TurnTranslator()
    t.start()
    events = t.image("/api/files/c1/chart.png", "chart")
    assert names(events) == [("thinking", "done"), ("block", None)]
    assert events[-1] == ("block", {"kind": "image", "url": "/api/files/c1/chart.png", "alt": "chart"})
    t.feed("messages", (AIMessageChunk(content="", id="m", usage_metadata={
        "input_tokens": 120, "output_tokens": 30, "total_tokens": 150,
        "input_token_details": {"cache_read": 100}}), META))
    t.feed("messages", (AIMessageChunk(content="", id="m", usage_metadata={
        "input_tokens": 0, "output_tokens": 5, "total_tokens": 5}), META))
    assert t.finish(7) == [("done", {"messageId": 7, "cites": [], "tokens": {"in": 120, "out": 35, "cached": 100}})]


def test_finish_without_output_still_closes_thinking():
    t = TurnTranslator()
    t.start()
    assert names(t.finish(1)) == [("thinking", "done"), ("done", None)]


def test_full_turn_ordering():
    t = TurnTranslator()
    seq = t.start()
    seq += t.feed("messages", (text_chunk("Let me look."), META))
    seq += t.feed("tools", {"event": "tool-started", "tool_call_id": "1", "tool_name": "read_file", "input": {"file_path": "/home/daytona/data/sales.csv"}})
    seq += t.feed("tools", {"event": "tool-finished", "tool_call_id": "1", "output": ToolMessage("a\nb", tool_call_id="1")})
    seq += t.image("/api/files/c/x.png", "x")
    seq += t.feed("messages", (text_chunk("Done."), META))
    seq += t.finish(1)
    assert names(seq) == [
        ("thinking", "run"), ("thinking", "done"), ("text", None),
        ("activity", "run"), ("activity", "done"), ("block", None), ("text", None), ("done", None),
    ]
    assert seq[3][1]["label"] == "Reading sales.csv" and seq[3][1]["icon"] == "read"
    assert seq[4][1]["resultLine"] == "read 2 lines"


def test_labels_and_unknown_tool_icon():
    assert tool_label("execute", {"command": "pip install -q pandas matplotlib"}) == "Installing pandas matplotlib"
    assert tool_label("glob", {"pattern": "*.csv"}) == "Finding *.csv"
    t = TurnTranslator()
    t.start()
    run = t.feed("tools", {"event": "tool-started", "tool_call_id": "x", "tool_name": "task", "input": {"description": "dig"}})
    assert run[-1][1]["icon"] == "read" and run[-1][1]["label"] == "Delegating: dig"


def test_sse_format():
    assert sse("text", {"delta": "é"}) == 'event: text\ndata: {"delta": "é"}\n\n'
