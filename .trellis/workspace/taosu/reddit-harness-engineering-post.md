# Reddit Post: Harness Engineering

**Source**: translated and lightly simplified from `eng.md`

---

## Title

```
Why bigger context windows won’t replace Harness Engineering
```

### Alternatives

- `Bigger context windows won't save your AI coding agent`
- `I used to chase bigger context windows. Then I understood attention.`
- `The real ceiling isn't window size. It's attention.`

---

## Body

Here's the story.

A few days ago I scrolled past a post titled something like *"the job title 'programmer' is about to go extinct."* I assumed it was the usual doom-mongering. But I actually clicked, and what the author was saying was this:

Going forward, programmers should rebrand as **Harness Engineers**.

He described himself as "a human harness" — running Codex for design and review, running Claude Code for implementation, and handling other work async in between. Then he dropped one line that stopped me:

> "A human's context window is only a few kilobytes of tokens."
> 

Go back a few months. There was a clear industry trend where every frontier model release was a flex about context window size. 128K not enough? Here's 256K. 256K not enough? Here's 1M. As if the only thing standing between us and reliable agents was more space.

I used to think that too. Then I started noticing that **what's supposed to forget still forgets.**

You have a 100-message conversation with Claude. On message 5 you clearly state "the return format for this endpoint must be X." By message 80 it's generating a completely different format. You scroll back: message 5 is still there, in black and white. It just isn't looking.

The window is big enough. The content is visible. The model still doesn't look.

It's like walking into an infinite library. The library is vast, every book is there, nothing is missing. But you have no index, no table of contents, no librarian telling you which book to open first. You can only read front-to-back, and the important parts drown in the noise.

Which means the bottleneck is attention.

If you've poked at the Transformer architecture a little bit, you can feel this intuitively. Every token attends to every other token in theory, but in practice, as context grows, the early information gets severely diluted in the attention scores. The model's attention is like a flashlight, always shines brightest on the most recent content, and the light dims the further back you go.

Google gave this a name: [**Lost in the Middle**](https://arxiv.org/abs/2307.03172). A critical instruction placed in the middle of a long context is significantly less likely to be retrieved than the same instruction placed at the beginning or the end. Put a key rule at token position 5000 of a 100K context versus in the last sentence, and the behavioral difference is night and day.

So when everyone is chasing bigger context windows, they're chasing a mirage. The window can keep growing, but attention stays finite.

Sound familiar? *Attention is all you need.* That paper gave us Transformers, gave us LLMs, gave us everything we're doing today. But read the other way, it's also a curse: attention is **ALL** you need — you only have so much of it, and anything beyond that is wasted.

---

OK, so if a bigger context window won't save us, what will?

This is where I think there's an important conceptual evolution most people haven't clocked. AI engineering has gone through three quiet paradigm shifts in the last two years.

**First: Prompt Engineering.** Roughly 2023 to early 2024. Everyone was studying how to talk to the model. Few-shot, chain-of-thought, role-play. The hottest job title was Prompt Engineer. The core skill was phrasing.

**Second: Context Engineering.** Mid-2024 onward. Talking better wasn't enough — the model had to see the right information. RAG, memory systems, knowledge bases, MCP. Karpathy stood up and said Context Engineering is the real engineering: the whole game is making sure the model sees the right things at the right time.

**Third: Harness Engineering.** Now. Anthropic started writing about it this year on their [engineering blog](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).

The analogy that clicked for me: Prompt Engineering is teaching a new hire how to talk. Context Engineering is giving them a well-stocked desk. Harness Engineering is building them the entire workflow and management system.

You can't expect an employee to remember one specific thing you said in a meeting three months ago. But you can write that thing into the SOP, into the process doc, into the checklist they have to read before every new task.

That's what a harness is for: holding the stuff the model's going to forget anyway.

---

In practice, the harness engineering folks have converged on two pain points every long-running agent hits.

The first is what people call **context anxiety**. Long task, context window filling up, the model starts panicking, just like a student with five minutes left in the exam, skipping steps, rushing the ending, declaring the task "complete." Cognition reportedly noticed this first while building Devin.

The second is **self-evaluation bias**. Ask an agent to evaluate its own work and it always thinks it did fine. Reads the code, writes PASS. The UI looks nice, ship it. Never mind that half the buttons don't actually do anything.

Their fixes:

**For context anxiety: Context Reset.** The fix is surprisingly dumb: clear the context completely, drop in a fresh prompt with the essential background, and let the agent run on a clean slate. Sounds brutal. Beats every fancy compression scheme I've tried.

**For self-evaluation bias: Generator / Evaluator separation.** The one doing the work and the one judging it must be two different agents. The evaluator's system prompt is blunt: assume this implementation is broken and go prove it. Every verification must leave a reproducible command output. A PASS without output is not a PASS(It's a bit like a state machine, isn't it? Harness is essentially cybernetics).

You can see these ideas baked into Claude Code itself. The `TodoWrite` tool validates task structure via schema, and the system prompt enforces one-task-in-progress-at-a-time: pacing is embedded into the tool design. Coordinator mode spawns a fresh zero-history agent when context starts to drift, instead of letting a polluted long-context session keep running.

The judgment underneath all of it is one question: **is the existing context helping you, or hurting you?**

And the core logic of the whole approach is one sentence: **the system does the remembering on the model's behalf.**

---

Honestly, when I read Anthropic's designs, I had a strong sense of being validated. Because I'd spent a long time building something similar.

The project is called **Trellis**. It's a workflow system for AI coding agents, and it runs across every major AI coding tool I could get my hands on — Claude Code, Cursor, Codex, OpenCode, and others.

Trellis's core design principle, one line:

> **Specs Injected, Not Remembered.**
> 

Don't expect the AI to remember the coding conventions you set three days ago. Don't expect it to remember your API response format, your directory structure rules, your error-handling principles.It will definitely forget. A bigger context window doesn't help. The forgetting is what attention is supposed to do.

So we flipped the approach. We don't ask the AI to remember anything. Every time the AI starts working, Trellis's hook system injects everything it needs to know at the moment of startup. 

**Layer 1: SessionStart.** Every time a new conversation starts, this hook fires automatically and injects the current workflow state, coding guidelines, and task progress. This guarantees that even if the previous conversation's context is completely lost, such as you closed the terminal, the context got compacted, you came back the next day — the new session picks up seamlessly. What you were doing, where you left off, what's next, then AI knows all of it in the first second.

**Layer 2: PreToolUse.** This hook fires before every sub-agent spawn. Trellis splits work into role-specific agents: the `implement` agent writes code, the `check` agent reviews, the `debug` agent fixes bugs, the `research` agent investigates. When each agent starts, the hook pulls scoped context from a dedicated JSONL based on the agent's role and injects it. The `implement` agent gets implementation specs. The `check` agent gets review specs. They each see their own thing and don't drown in each other's noise.

This is the opposite of dumping everything into one giant context window.

Old approach: here's a 1-million-token library, good luck finding what you need.

New approach: you're doing frontend work today? Here are the three files your task needs. Ignore the rest.

It's like a good project manager who doesn't dump every company document on a new hire's first day. They look at what the person is actually doing and put the relevant folder on their desk. The rest stays filed away.

The core logic is the same throughout: **go with the grain of the attention mechanism.**

Attention favors the most recent tokens, so the hook system injects whatever the current task needs right before execution. Early tokens in long context get diluted — so no task runs in long context at all. Every task starts on a clean slate, with the background re-injected on the spot. Self-evaluation is unreliable, which is why writing and reviewing live in separate roles, with an automated quality loop between them.

None of this is magic. Every individual component is simple. But combined, they form a complete harness that lets the AI make steady progress across long tasks spanning many context windows.

I'm still figuring things out. Trellis is far from perfect. But I think the direction is right.

---

After doing this for a while, the thing I keep coming back to:

**When you evaluate whether an agent is good, you're evaluating the model and the harness together, as one system.**

The model is just an engine. But put that engine in different chassis and the results are completely different. An F1 engine in a tractor chassis can't run F1 speeds. But drop an ordinary engine into an aerodynamically perfect body, with a precise gearbox and a trained driver, and the lap times come out surprisingly good.

This is why some people build unbelievable things with Claude Code while others use the exact same model and conclude AI coding is useless.

The harness is almost always the difference.

It's also why the guy in that original post said programmers should rebrand as Harness Engineers. The core of the job is shifting from *writing code* to *designing a system that lets AI write code effectively* : a system that surfaces the right API docs on demand, runs verification pipelines where agents cross-check each other, and re-persists your requirements at the start of every new session so the agent never has to remember them.

---

Humans have been doing harness engineering for thousands of years. We just didn't call it that.

Think about it. Why did humans invent writing? Because our biological memory is too unreliable. Oral tradition drifts — after a few generations, the original is unrecognizable. Writing was humanity's first context persistence layer. Lock the information in so it doesn't depend on anyone's memory.

Why do we have laws, SOPs, operating manuals? Because writing alone isn't enough — you need a system to make sure the right information reaches the right person at the right time. Judges don't decide cases from memory. They open the code book.

Why do companies do morning standups, weekly reviews, write PRDs, do code reviews? Isn't it because human attention is limited, human memory is unreliable, and we need a process to re-inject critical information repeatedly?

Harness engineering isn't a new invention of the AI era. This is what human civilization has been doing for thousands of years. The only thing that's changed is the target — we used to build harnesses for humans, and now we build them for AIs too.

And ironically, the underlying logic is almost identical: attention is finite, memory decays, self-evaluation is unreliable, and there's always more information than attention to go around.

*Attention is all you need.*

It's a technical principle for AI, and — if you squint — a summary of the entire history of human civilization.

---

Back to the original post. The guy said a human's context window is only a few kilobytes.

Whether you're a human or an AI, I don't think context window size was ever the deciding factor. The deciding factor is whether you have a system that ensures, when your attention lands on a particular spot, the right thing is sitting there waiting for you.

A big library is less useful than a good librarian.
A big context is less useful than a good harness.

I don't know if "Harness Engineer" will stick as a job title. What I do know is that "writing code" is depreciating as a skill faster than it's ever depreciated, and "designing a system that lets AI work effectively" is where the value is moving.

Prompt Engineering is table stakes now. Context Engineering is becoming mainstream. Harness Engineering is still very early. Anthropic only recently started writing about the concept systematically. Claude Code's source code is only starting to show these patterns. When I started building Trellis, the term didn't even exist.

We were just repeatedly running into walls. Discovering that a bigger context window didn't help. Discovering that the AI kept forgetting conventions. Discovering that an agent reviewing its own work always passed. And solving each problem one at a time. Then looking back and realizing — oh, Anthropic has a name for this now. They call it Harness Engineering.

That's probably what good engineering practice looks like — the concepts come out of the problems after you've been wrestling with them.

The ceiling was always about whether the right thing showed up at the right time. That's what a harness does.

In this era, *attention is all you need* — for humans and for AI alike.

---

If you want to see how any of this is implemented: [github.com/mindfold-ai/Trellis](https://github.com/mindfold-ai/Trellis). AGPL-3.0, open source.