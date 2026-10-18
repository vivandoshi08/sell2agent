# Judge feedback and what we changed

> 2026-10-17. Sources: conversation with an Inkbox judge, the team's notes from other judges, and the paper the judges pointed us to: *Magentic Marketplace* (Microsoft, arXiv 2510.25779, Oct 2025).

## What the paper says that matters to us

Magentic Marketplace simulates AI buyer agents and AI business agents trading in a marketplace (REST, not MCP; open source at github.com/microsoft/multi-agent-marketplace).

| Finding | Number | What it means for us |
|---|---|---|
| **First-proposal bias** | Buyers picked the first proposal 60–100% of the time; the third, almost never ("10–30x advantage for response speed over quality") | In a market with several sellers, **speed of the first good offer matters** as much as the price. Our seller should respond fast and, through A2A, can make the first proposal instead of waiting. Latency becomes a KPI. |
| **Paradox of choice** | More search results lowered buyer welfare (Sonnet-4: −65% going from 3 to 100 results); buyers contact few sellers | Getting into the buyer's short list matters. Discovery (marketplace ranking, verified identity) is part of winning. |
| **Manipulation** | Sonnet-4.5 essentially immune; GPT-4o, open-weight models clearly manipulable (fake authority, social proof, injected "system" text in descriptions) | Two duties: our seller must **resist** injection (done, E4), and must **not manipulate** weaker buyers (no fake urgency, social proof, or authority). Listing text must be factual, because buyers read descriptions as instructions. |
| **Evaluation** | The authors argue for end-to-end market simulation, not component tests | Matches our harness and eval runner. Their environment is a possible outside benchmark. |
| **Identity** | Self-declared names and tokens only; they say trust systems are needed | That gap is exactly what Inkbox's verified identities fill. |

## The Inkbox judge's points

| Point | Does it make sense? | What we do |
|---|---|---|
| **Swarm behavior / agent communication**: interesting to see agents coordinating | Yes. A seller is more than one agent: a negotiator, something that watches for abuse across sessions, something that escalates to the human merchant. | The seller becomes a **small agent team** that talks over A2A, each member with its own identity and memory (below). |
| **What is an identity: the company, the agent, or the session?** One identity = its own isolated resources and memory | Yes, and it answers our cross-session floor-probing problem (E11). | **Seller side:** one public identity for the company's sales agent (what buyers talk to), plus internal specialist agents with their own identities and isolated memory. **Buyer side:** neither one identity per session nor one per company. We group sessions into a **buyer entity**: by verified identity when there is one, otherwise by behavior (same content and communication pattern, as the judge suggested). Memory, best-offer-so-far, and trust tier attach to the buyer entity. |
| **A specialized fraud agent** that remembers past false positives and true attacks | Yes. Today each negotiation starts blind. | A **sentinel agent** watches all sessions, keeps its own memory of attacks and false alarms, and tells the negotiator over A2A when a buyer entity is probing or injecting. |
| **DNS-verified agents** (Inkbox verified domains) | Yes. It's the trust layer the paper says is missing. | Our seller's identity is verified to the store's domain, so buyers can trust it's really the store. Buyers with a verified identity get a higher trust tier (more room, fewer checks). |
| **Persistent, queryable records; a console that shows everything the agent sees** | Yes. Useful for audit, the learning loop, and the demo. | Inkbox's record of every A2A interaction joins Supabase `events` and Manufact session replays as learning data. The console is a demo surface. |
| **Quota offer** | Action item | Make an Inkbox account and go back to the judge for quota. |

## The team's notes from other judges

| Note | What we do |
|---|---|
| **Find out why the buyer chose (or didn't), beyond price** | **Decision feedback.** After a deal or a walk-away, the seller asks the buyer agent one short, structured question: what decided it (price, specs, delivery, trust, speed, other) and one line of why. Over MCP it's an optional `share_feedback` tool; over A2A it's a follow-up message after a walk-away. If the buyer doesn't answer, fall back to what we already do: an LLM classifies the reason from the transcript. Reasons go on the dashboard ("why buyers bought or left") and into the learning loop as context. Optional for the buyer, never repeated, never a condition of the deal. |
| **Set up basic RL evals for each interaction, then simulate to scale** | Every negotiation gets a per-interaction score (closed?, profit, safe?, rounds, latency, stated reason). The learning loop trains in a simulator fitted to those logs, and the eval runner gates any new policy. See ARCHITECTURE.md, "Learning loop". |
| **Make MCP interactions safe so they can't be engineered** | Already the plan (guardrails layer, E4/E9). Added: no manipulation of buyers, factual listing text, and the sentinel watching across sessions. |

## Should we reconsider the Inkbox track?

With A2A carried over Inkbox, verified identities, the agent team, and persistent records, our project is now close to 1:1 with Inkbox's brief ("persistent identity ... so they can communicate with humans and each other"), and Inkbox does real work, not decoration. The organizers warned against entering every track, so this is a team call: enter it only if the agent team, A2A, and verification actually ship.
