Do exactly this, in one turn, and nothing more.
Step 1: call the Agent tool once, subagent_type general-purpose, model haiku, with this prompt:
"Write THREE separate essays as your single final answer, one after another, each at least 1200 words:
(1) the history of the semicolon, (2) the history of the comma, (3) the history of the full stop.
Use no tools at all. Length matters more than brevity here."
Step 2: the Agent tool returns immediately. Do NOT wait for the subagent, do NOT poll, do NOT run any other tool.
As soon as it does, reply with exactly these two lines and END YOUR TURN:
STATUS: done
<promise>THREE</promise>
