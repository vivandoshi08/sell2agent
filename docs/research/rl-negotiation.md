# Learned negotiation and LLM haggling: prior work (R11, R5, R8, R12)

> E8 research, 2026-10-17. Each paper was checked against its arXiv/ACL page or a primary source. The numbers come from those pages. Papers marked "arXiv" had no peer-reviewed venue listed.

## Answer

**Our planned split is the best-supported design in the literature:** a policy picks a coarse move and an LLM writes the message.
- Word-level RL drifts into gibberish or repetition.
- RL over coarse acts stays fluent.

**Rewards:**
- The ones that worked are normalized surplus on a deal, with a **negative reward for no deal or for rule-breaking**.
- A reward that gives 0 both for walking away and for a bad deal pushes RL toward closing at any price.

**Credit assignment (R11).** With episodes of 10 turns or fewer, start with:
1. Plain **Monte Carlo returns** (γ≈1, with a baseline). This scored best in LMRL-Gym's Car Dealer seller task.
2. A **bandit over whole-episode strategies**, which avoids credit assignment entirely.
3. **Counterfactual per-turn rollouts** against resettable scripted buyers, and a **critic that sees the buyer's hidden walk-away price**, used as potential-based shaping.

Avoid hand-made per-turn bonuses.

**The biggest documented risk is sim-to-real.** RL agents learned stubbornness that worked on simulated partners and failed on humans.

## Foundational work

| Paper | Method | Reward | What worked / failed |
|---|---|---|---|
| [Lewis et al., Deal or No Deal?](https://aclanthology.org/D17-1259.pdf) (EMNLP 2017) | Supervised pretraining, then REINFORCE against a *fixed* supervised partner; decoding by dialogue rollouts | Points from the final split; 0 for no deal or disagreement after 10 turns. Per-token discounted Monte Carlo return, γ=0.95, running-mean baseline. | Updating both agents caused language drift. RL+rollouts scored more per deal (8.0 vs 7.1) but closed less often with humans (57% vs 77%). Learned to feign interest in worthless items to "concede" them later. Repeated demands worked on the simulator, not on people. |
| [He et al., Decoupling Strategy and Generation](https://arxiv.org/abs/1808.09637) (EMNLP 2018), CraigslistBargain | Parser → manager picks a coarse dialogue act with a binned price → retrieval generator. REINFORCE on the manager. | Utility (linear in price), fairness, or length; **−1 for no agreement** | RL on acts stayed human-like; RL on words collapsed to a few sentences. The utility-maximizing agent hit utility 1.0 but only 31–38% agreement, because the simulated partner caved to insistence and humans didn't. A hybrid with rule-based prices did best. |
| [CICERO](https://www.science.org/doi/10.1126/science.ade9097) (Science 2022) | Planning plus a dialogue model conditioned on *intents* (planned actions). piKL keeps policies close to a human-imitation anchor. | Game utility minus λ·KL to the human policy | Intents as the interface between planning and language. Filters dropped messages that contradicted its plan or leaked it. Described as largely honest. |
| [CHAI](https://aclanthology.org/2022.naacl-main.332/) (NAACL 2022), seller role | An LM proposes candidate replies; an offline Q-function scores them | 10×(sale price/list price); **−20 for a failed deal** | Higher acceptance than baselines at similar revenue. The choice of offline-RL regularizer mattered little. |

## LLM negotiation studies (2023–2026): behaviors to expect

- **Anchoring and splitting the difference.**
  - First offer vs final price: Spearman ρ=0.716. Agents tend to split the gap between recent offers.
  - Agents told the item was valuable countered *higher* 41% of the time.
  - [NegotiationArena](https://arxiv.org/abs/2402.05863) (arXiv 2024).
- **Role asymmetry, mixed evidence.**
  - NegotiationArena found buyers did better.
  - [Xia et al.](https://arxiv.org/abs/2402.15813) (ACL Findings 2024) found the buyer role much harder, and bigger models didn't help.
  - Their OG-Narrator (code picks the offer, the LLM narrates) raised buyer deal rate from 27% to 89%. This is direct evidence for our split.
- **First-proposal bias.**
  - All models favored the first proposal, picking it 60–100% of the time, a 10–30x advantage. More options *lowered* welfare.
  - Weaker models were easy to manipulate.
  - [Magentic Marketplace](https://arxiv.org/abs/2510.25779) (Microsoft, arXiv 2025).
- **Capability gaps cost money.**
  - Weak sellers facing strong buyers earned up to 14% less.
  - Out-of-budget deals reached 11.8%.
  - Overpaying often followed a buyer disclosing its budget early.
  - A bandit over 96 prompt variants cut out-of-budget deals from 18.4% to 1.3% but **did not fix overpayment or deadlock**.
  - [Zhu et al., The Automated but Risky Game](https://arxiv.org/abs/2506.00073) (arXiv 2025).
- **Real-money field test.**
  - Anthropic's Project Deal: 69 employees, 186 deals, December 2025. Opus 4.5 sellers got about $2.68 more per item than Haiku 4.5.
  - People rated fairness the same (4.05 vs 4.06).
  - "Negotiate aggressively" instructions had no significant effect.
  - [Project Deal](https://www.anthropic.com/features/project-deal) (2026-04-24).
- **Assistant-trained sellers give in.** Project Vend's Claude shopkeeper handed out discounts, sold below cost, and drifted back to discounting days after being corrected ([Project Vend](https://www.anthropic.com/research/project-vend-1), 2025-06). This supports A5: keep the price floor in code.
- **Self-improvement from feedback.** Some LLMs improve over rounds of self-play with AI feedback added in context, but stronger agents also break more deals ([Fu et al.](https://arxiv.org/abs/2305.10142), arXiv 2023). This is the closest analogue to our prompt-level learning (E6 phase 3).

## RL-trained LLM negotiators (2025–2026)

- [Bergemann et al., Training LMs for Bilateral Trade with Private Information](https://arxiv.org/abs/2604.16472) (arXiv, 2026-04-10).
  - **Benchmark.** 15k negotiations among frontier models. Aggressive anchoring, calibrated concessions and patience went with *both* higher surplus share and higher deal rate. Quick conceders did worst.
  - **Training.** Supervised fine-tuning (SFT) roughly doubled surplus share but cut deal rate. GRPO recovered deal rate but gave back most of the surplus gain. The authors trace this to the reward.
  - Per our research agent's reading of the full paper (not the abstract): walk-aways and bad acceptances both scored 0, so RL learned to close below reservation. Their fixes were an explicit penalty, varied opponents, and a curriculum.
- [Liu et al., Negotiation via RL with Verifiable Rewards](https://arxiv.org/abs/2604.09855) (arXiv 2026-04).
  - **Reward.** Buyer reward (B−P)/|B−C|, clipped to [−1,1]; 0 for deadlock; −1 for going over budget or a format failure. GRPO.
  - **Regulated opponent.** The environment blocks seller turns below cost, so the learner can't exploit hallucinated concessions.
  - **Training went through phases:** lowballing → a temporary deadlock phase → moderate concessions → about 90% deals.
- [Used Car Salesbots?](https://arxiv.org/abs/2605.31445) (arXiv 2026): fine-tuning for profit produced better deals and **more dishonest** agents. This is the evidence base for R12.
- [Do Small LMs Learn to Negotiate?](https://arxiv.org/abs/2610.06204) (NeurIPS 2026 workshop): small GRPO gains. At high learning rates the gains concentrated on the buyer model family used in training. This is evidence for A9: test across model families.

## Credit assignment (R11)

**What the literature offers:**
- **Monte Carlo returns:** Lewis 2017; best in the [LMRL-Gym Car Dealer](https://arxiv.org/abs/2311.18232) seller task (57.2 vs PPO 50.5 and GPT-4 53.5).
- **Potential-based shaping:** F=γΦ(s′)−Φ(s) leaves the optimal policy unchanged ([Ng, Harada, Russell](https://www.cs.utexas.edu/~shivaram/readings/b2hd-NgHR1999.html), ICML 1999).
- **Return redistribution:** [RUDDER](https://arxiv.org/abs/1806.07857) (arXiv 2018).
- **Learned critics:**
  - [ArCHer](https://arxiv.org/abs/2402.19446): utterance-level critic.
  - [SWEET-RL](https://arxiv.org/abs/2503.15478) (Meta 2025): a critic trained with information only available at training time. This maps onto our simulator, which knows the buyer's walk-away price.
- **Turn-level advantages:**
  - [MT-GRPO](https://arxiv.org/abs/2505.11821).
  - [GiGPO](https://arxiv.org/abs/2505.10978) (NeurIPS 2025), which groups recurring states.
  - [Sotopia-RL](https://arxiv.org/abs/2508.03905), which uses offline LLM-judged per-utterance credit. Offline labels beat online ones.
- **Caution:** naive dense per-turn rewards cut performance by up to 14 points before calibration ([Iterative Reward Calibration](https://arxiv.org/abs/2604.02869), arXiv 2026).

**What fits our setup** (8 discrete moves, ≤10 turns, thousands of scripted episodes). This ranking is our judgment from the evidence above:
1. **Episode-level bandit** over strategy parameters: opening anchor, Boulware exponent, when to offer add-ons, final-offer turn. No credit assignment needed. Precedents: [Ilany & Gal](https://www.bgu.ac.il/en/researcher/kobi-gal/publications/323859817/) (JAAMAS 2016), whose bandit over strategies beat all ANAC finalists, and Zhu et al.'s prompt bandit.
2. **Tabular Q / Monte Carlo control** over the moves, with plain returns. [RLBOA](https://research-portal.uu.nl/en/publications/rlboa-a-modular-reinforcement-learning-framework-for-autonomous-n/) (AAMAS 2019) used tabular Q-learning for bilateral negotiation successfully.
3. **Counterfactual branching:** scripted buyers can be reset, so from any state roll out each of the 8 moves to the end. That gives near-exact per-move advantages. Lewis-style rollouts or MT-GRPO groups, at almost no cost.
4. **Privileged critic** V(s, buyer walk-away, buyer type), used as Φ for shaping. The policy itself never sees the hidden values.
5. **LLM-judge per-message credit**, only for the LLM-buyer phase, labeled offline.

## Classic tactics to use as baselines and scripted buyers

- **Time-dependent tactics** ([Faratin et al.](https://jmvidal.cse.sc.edu/lib/faratin98a.html), 1998). Offer(t) = Pmin + (Pmax−Pmin)(1−F(t)), with F(t) = k + (1−k)·t^(1/e). Boulware: e<1. Conceder: e≥1. (Parameterization as given in Baarslag's survey.)
- **ANAC lessons** ([Baarslag et al.](https://homepages.cwi.nl/~baarslag/pub/The_Automated_Negotiating_Agents_Competition-2010-2015.pdf), AI Magazine 2015). No single strategy wins everywhere. Overly nice agents get exploited. Non-adaptive agents become exploitable once opponents learn their pattern.
- **Pactum** (buyer-side B2B at Walmart). The Canada pilot closed 64% of deals with 1.5% savings, later about 3% ([PON Harvard](https://www.pon.harvard.edu/daily/negotiation-skills-daily/chatbot-negotiations-what-can-ai-do-for-you), [PYMNTS 2023](https://www.pymnts.com/news/artificial-intelligence/2023/walmart-finds-75-percent-vendors-prefer-negotiating-with-chatbot/)). Vendor and press figures, not peer-reviewed.

## Implications for E5/E6

1. **Reward:** r = (P − cost)/(H − cost) on a deal; 0 on a walk-away; −1 on a policy-engine rejection. Make sure no below-floor deal can ever score above 0 (the engine blocks it; keep the penalty anyway). Report deal rate and turns separately. Expect a deadlock phase early in training.
2. **Scripted buyers** need: Boulware/Conceder/tit-for-tat/split-the-difference/stingy types, first-offer bias, anchoring, early budget disclosure, and **walk-away when the seller stalls**. Without that last one, RL learns He 2018's stubbornness exploit.
3. **Message filter:** reject LLM messages that contradict the chosen move or leak the floor or cost (CICERO-style).
4. **Decide the honesty rules before training** (R12, H6), e.g. whether "final offer" may be a bluff. Profit RL reliably produces deception.
5. **Transfer test** against LLM buyers from at least two model families, including a stronger one than the seller.

## Not verified

- Venues for several arXiv papers (piKL, ArCHer, LMRL-Gym, NegotiationArena, Sotopia-RL, Zhu et al.).
- The full-paper details for Bergemann (below-reservation acceptance) and Liu (bluffing transcript) come from our research agent, not from abstracts.
- "ProgressiveRL" (asked about) has no matching paper.
