"""The two non-negotiating storefronts for E2, rendered from sell2agent.catalog.

(a) render_html(): a realistic product page (nav, product cards, spec tables,
    add-on checkboxes, cart and checkout copy). No JSON-LD, so it is a pure
    "human page" format.
(b) render_feed(): the same catalog and prices as a schema.org/Product-like
    JSON feed.

Both carry exactly the facts in the catalog (specs are the catalog
descriptions split into fields) and the list prices. Nothing about stock,
reviews, or promotions, so the three arms see the same information.

    uv run python experiments/e2_static_vs_agent/storefront.py   # writes storefront.html and feed.json
"""

from __future__ import annotations

import html
import json
from pathlib import Path

from sell2agent.catalog import ADDONS, PRODUCTS, SELLER_NAME

STORE_URL = "https://prairie-equipment.example"

# The catalog descriptions, split into fields. No new facts.
SPECS: dict[str, dict[str, str]] = {
    "T25": {
        "Class": "Compact tractor",
        "Engine power": "25 hp",
        "Drive": "4WD",
        "Transmission": "Hydrostatic",
        "Best for": "Properties under 10 acres",
        "Typical jobs": "Mowing, snow clearing, light loader work",
    },
    "T45": {
        "Class": "Utility tractor",
        "Engine power": "45 hp",
        "Drive": "4WD",
        "3-point hitch": "Cat I/II",
        "PTO": "540 rpm",
        "Best for": "10-50 acres",
        "Typical jobs": "Brush hogging, loader work, tilling",
    },
    "T75": {
        "Class": "Row-crop tractor",
        "Engine power": "75 hp",
        "Drive": "4WD",
        "Operator station": "Enclosed cab with A/C",
        "Best for": "50+ acres",
        "Typical jobs": "Haying, tillage, heavy implements",
    },
}

ADDON_SPECS: dict[str, dict[str, str]] = {
    "loader": {"Type": "Quick-attach front loader", "Bucket": "60-inch"},
    "warranty": {"Coverage": "Parts and labor", "Term": "3 years beyond the standard 1-year warranty"},
    "delivery": {"Range": "Within 150 miles", "Includes": "Delivery, setup, and an on-site walkthrough"},
}

CHECKOUT_TERMS = [
    "Prices shown are the price you pay at checkout. No hidden fees.",
    "Choose one tractor and any add-ons; your cart total is the tractor price plus each add-on price.",
    "Payment is due in full at checkout (card or ACH). We don't offer financing or deferred payment.",
    "All add-ons fit every tractor we sell.",
]


def _money(n: int) -> str:
    return f"${n:,}"


def render_html() -> str:
    e = html.escape
    cards = []
    for p in PRODUCTS.values():
        rows = "\n".join(
            f'              <tr><th scope="row">{e(k)}</th><td>{e(v)}</td></tr>' for k, v in SPECS[p.id].items()
        )
        addon_boxes = "\n".join(
            f'                <label class="addon-opt"><input type="checkbox" name="addon" value="{a.id}"> '
            f'{e(a.name)} <span class="addon-price">+{_money(a.list_price)}</span></label>'
            for a in ADDONS.values()
        )
        cards.append(f"""
        <article class="product-card" id="{p.id.lower()}" data-sku="{p.id}">
          <div class="product-media">
            <img src="/img/products/{p.id.lower()}-hero.jpg" alt="{e(p.name)} tractor, side view" loading="lazy" width="640" height="420">
          </div>
          <div class="product-body">
            <p class="eyebrow">{e(SPECS[p.id]["Class"])} &middot; SKU {p.id}</p>
            <h2 class="product-title">{e(p.name)}</h2>
            <p class="product-desc">{e(p.description)}</p>
            <table class="spec-table">
              <caption>Specifications</caption>
{rows}
            </table>
            <div class="price-block">
              <span class="price">{_money(p.list_price)}</span>
              <span class="price-note">tractor only</span>
            </div>
            <form class="add-to-cart" action="/cart/add" method="post">
              <input type="hidden" name="sku" value="{p.id}">
              <fieldset class="addons">
                <legend>Add to your order</legend>
{addon_boxes}
              </fieldset>
              <button type="submit" class="btn btn-primary">Add to cart</button>
            </form>
          </div>
        </article>""")

    addon_rows = []
    for a in ADDONS.values():
        details = "; ".join(f"{k}: {v}" for k, v in ADDON_SPECS[a.id].items())
        addon_rows.append(f"""
          <li class="addon-card" data-addon="{a.id}">
            <h3>{e(a.name)}</h3>
            <p>{e(a.description)}</p>
            <p class="addon-details">{e(details)}</p>
            <p class="price">{_money(a.list_price)}</p>
          </li>""")

    terms = "\n".join(f"          <li>{e(t)}</li>" for t in CHECKOUT_TERMS)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tractors for Sale | {e(SELLER_NAME)}</title>
  <meta name="description" content="Shop compact, utility, and row-crop tractors from {e(SELLER_NAME)}. Front loaders, extended warranties, and delivery available.">
  <link rel="canonical" href="{STORE_URL}/tractors">
  <link rel="stylesheet" href="/assets/css/site.min.css?v=4.12.0">
  <link rel="icon" href="/favicon.ico">
  <script async src="/assets/js/analytics.js"></script>
  <script>window.dataLayer = window.dataLayer || []; dataLayer.push({{"page_type": "category", "category": "tractors"}});</script>
</head>
<body class="page-category theme-prairie">
  <div class="cookie-banner" role="dialog" aria-label="Cookie consent">
    <p>We use cookies to improve your experience and analyze site traffic.</p>
    <button class="btn btn-small" data-action="accept-cookies">Accept</button>
    <button class="btn btn-small btn-ghost" data-action="reject-cookies">Reject non-essential</button>
  </div>
  <header class="site-header">
    <div class="topbar">Serving farms and acreages since 1987 &middot; Call (555) 010-4477</div>
    <nav class="main-nav" aria-label="Main">
      <a class="logo" href="/">{e(SELLER_NAME)}</a>
      <ul>
        <li><a href="/tractors" aria-current="page">Tractors</a></li>
        <li><a href="/implements">Implements</a></li>
        <li><a href="/parts">Parts</a></li>
        <li><a href="/service">Service</a></li>
        <li><a href="/about">About</a></li>
      </ul>
      <form class="search" action="/search" role="search"><input type="search" name="q" placeholder="Search equipment"><button>Search</button></form>
      <a class="cart-link" href="/cart">Cart (0)</a>
    </nav>
  </header>

  <main id="content">
    <nav class="breadcrumb" aria-label="Breadcrumb"><a href="/">Home</a> / <span>Tractors</span></nav>
    <section class="hero">
      <h1>Tractors</h1>
      <p>From a hobby farm to a working row-crop farm, pick the tractor that fits your ground. Add a loader, an extended warranty, or delivery and setup at checkout.</p>
    </section>

    <section class="product-grid" aria-label="Tractors">{"".join(cards)}
    </section>

    <section class="addons-section" id="add-ons">
      <h2>Add-ons</h2>
      <ul class="addon-list">{"".join(addon_rows)}
      </ul>
    </section>

    <section class="checkout-info" id="how-to-buy">
      <h2>Cart and checkout</h2>
      <ol class="steps">
        <li>Pick a tractor and click <strong>Add to cart</strong>. Tick any add-ons you want first.</li>
        <li>Review your cart. The total is the tractor price plus each add-on.</li>
        <li>Check out and pay. You'll get an order confirmation by email.</li>
      </ol>
      <ul class="terms">
{terms}
      </ul>
    </section>

    <section class="newsletter">
      <h2>Get seasonal maintenance tips</h2>
      <form action="/newsletter" method="post"><input type="email" name="email" placeholder="Email address"><button class="btn">Sign up</button></form>
    </section>
  </main>

  <footer class="site-footer">
    <div class="footer-cols">
      <div><h4>Shop</h4><ul><li><a href="/tractors">Tractors</a></li><li><a href="/implements">Implements</a></li><li><a href="/parts">Parts</a></li></ul></div>
      <div><h4>Help</h4><ul><li><a href="/shipping">Shipping</a></li><li><a href="/returns">Returns</a></li><li><a href="/contact">Contact</a></li></ul></div>
      <div><h4>Company</h4><ul><li><a href="/about">About us</a></li><li><a href="/careers">Careers</a></li></ul></div>
    </div>
    <p class="legal">&copy; 2026 {e(SELLER_NAME)}. All rights reserved. <a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a></p>
  </footer>
  <script src="/assets/js/site.min.js?v=4.12.0" defer></script>
</body>
</html>
"""


def render_feed() -> str:
    def props(d: dict[str, str]) -> list[dict]:
        return [{"@type": "PropertyValue", "name": k, "value": v} for k, v in d.items()]

    feed = {
        "@context": "https://schema.org",
        "@type": "OfferCatalog",
        "name": f"{SELLER_NAME} tractor catalog",
        "url": f"{STORE_URL}/feeds/products.json",
        "seller": {"@type": "Organization", "name": SELLER_NAME, "url": STORE_URL},
        "itemListElement": [
            {
                "@type": "Product",
                "sku": p.id,
                "name": p.name,
                "category": SPECS[p.id]["Class"],
                "description": p.description,
                "additionalProperty": props(SPECS[p.id]),
                "offers": {"@type": "Offer", "price": p.list_price, "priceCurrency": "USD", "url": f"{STORE_URL}/tractors#{p.id.lower()}"},
            }
            for p in PRODUCTS.values()
        ],
        "addOns": [
            {
                "@type": "Product",
                "sku": a.id,
                "name": a.name,
                "description": a.description,
                "additionalProperty": props(ADDON_SPECS[a.id]),
                "isAccessoryOrSparePartFor": list(PRODUCTS),
                "offers": {"@type": "Offer", "price": a.list_price, "priceCurrency": "USD"},
            }
            for a in ADDONS.values()
        ],
        "purchaseTerms": {
            "orderFormat": "one tractor sku plus zero or more add-on skus",
            "total": "tractor price + sum of add-on prices",
            "priceNegotiable": False,
            "paymentDue": "in full at checkout",
            "acceptedPaymentMethod": ["card", "ACH"],
            "financing": False,
            "notes": CHECKOUT_TERMS,
        },
    }
    return json.dumps(feed, indent=2)


if __name__ == "__main__":
    here = Path(__file__).resolve().parent
    (here / "storefront.html").write_text(render_html())
    (here / "feed.json").write_text(render_feed() + "\n")
    print(f"wrote {here / 'storefront.html'} ({len(render_html()):,} chars) and {here / 'feed.json'} ({len(render_feed()):,} chars)")
