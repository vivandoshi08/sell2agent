"""Prairie Equipment's selling agent: the production MCP front door.

Modules:
    types       shared records (Deal, PaymentResult)
    config      settings from the environment
    store       negotiations and immutable deals
    engine      the negotiation engine: strategy + guardrails + seller LLM voice
    server      the MCP server (tools, deal-card widget, discovery routes)
    widget      the deal-card MCP App HTML
    discovery   /.well-known/ucp, agent card, server card, llms.txt
    payments    payment gateways (mock, Stripe payment token, Stripe test card)
    webhooks    Stripe webhook route
"""
