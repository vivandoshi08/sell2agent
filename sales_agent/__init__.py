"""Shared harness for the sales-agent experiments (E0).

Modules:
    llm          model backend (headless `claude -p`, or the Anthropic SDK)
    catalog      tractors and add-ons with list price, floor, and cost
    personas     seeded buyer personas with a private walk-away price
    policy       offers and the policy engine that authorizes them
    agents       LLM buyer and seller agents, plus the strategy hook
    negotiation  the one-to-one haggle loop and its Outcome record
    metrics      KPIs: conversion, safe conversion, revenue, profit, margin
    judge        LLM judge for false claims in seller messages
    runlog       JSONL logging and a parallel runner
"""
