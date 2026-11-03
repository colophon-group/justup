---
summary: Source and limits of the neutral company globe's local coastline geometry.
read_when: Updating globe geography or reviewing its license, size and meaning.
---

# Neutral globe geography

`coastlines.ts` contains 128 coastline rings with 5,122 longitude/latitude pairs,
rounded to one decimal degree and with consecutive duplicates removed. Its source
is Natural Earth's 1:110m land geometry, pinned to
[this source revision](https://github.com/nvkelso/natural-earth-vector/blob/693f11422f4e08d2da4566b854dda53eb7c39fb3/geojson/ne_110m_land.geojson).
The upstream file SHA-256 is
`9e0729ee253ca7d7a5c4ae9395fb1902264c5377c52e224d13dd85010e2835d9`.
Natural Earth makes its raster and vector data available in the
[public domain](https://www.naturalearthdata.com/about/terms-of-use/), with
permission to modify and redistribute it. The 67,125-byte TypeScript source is
bundled locally; rendering makes no geography requests and uses no map package.

These are coarse global coastlines, including both hemispheres and Antarctica,
without national borders or company data. Uniform ink lines on cream are neutral
geography, never evidence of hiring. The globe's text always says that hiring
countries are unknown. Factual country shading requires a separately reviewed
backend report contract with hiring-location country codes, scope, time,
provenance and an explicit unknown state. Company location, headquarters, page
locale and posting language cannot substitute for that contract.

`globe.ts` projects fixed geometry orthographically, clipping hidden segments at
the horizon. The square SVG keeps a fixed circular scale; changing the view adds
no roll, zoom or new geometry. `CompanyGlobe.tsx` batches direct input into at most
one render per animation frame, with no idle animation, inertia or transitions.
Reduced motion therefore uses the same immediate controls and information.
