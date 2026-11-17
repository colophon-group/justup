---
summary: Sources and limits of the company globe's local coastlines and country fills.
read_when: Updating globe geography or reviewing its license, size and meaning.
---

# Company globe geography

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

These are coarse global coastlines, including both hemispheres and Antarctica.
Uniform ink lines on cream show neutral geography.

`country-boundaries.ts` holds 18,269 simplified vertices across 245 country
codes, derived from [Natural Earth 1:50m map units](https://github.com/nvkelso/natural-earth-vector/blob/693f11422f4e08d2da4566b854dda53eb7c39fb3/geojson/ne_50m_admin_0_map_units.geojson)
at the same revision. The source SHA-256 is
`bb2ac884621bfc0ba942b6142fdf4ad409a40a49d33082590b026050aa20e340`.
Features use `ISO_A2` where supplied. Uncoded units use the `ADM0_A3` to ISO
crosswalk from GeoNames, with Natural Earth's `PSX` mapped to `PS`. Rings use
Douglas–Peucker simplification at 0.24° and coordinates rounded to 0.01°.
These boundaries are cartographic context. The browser loads this same-origin
compiled asset when the report contains observed countries. The textual list
keeps every evidenced code, including BV, GI, TV and UM, for which this asset
supplies no shape.

The [report contract](../../../../docs/company-hiring-reports.md#read-current-structured-samples)
supplies country codes independently of map geometry. The server's ID-to-code
table retains the GeoNames ID and ISO columns from the [GeoNames country extract](https://download.geonames.org/export/dump/countryInfo.txt)
(CC BY 4.0), SHA-256
`79f8f59ea01cbb40438bf1856dd6c2ff201f03f8fc72d0530b2646aaf603ef04`.
The table omits retired codes AN and CS, and the user-assigned code XK.

`globe.ts` projects fixed geometry orthographically, clipping hidden segments at
the horizon and closing partly visible country rings along the rim. The square
SVG keeps a fixed circular scale. Changing the view adds
no roll, zoom or new geometry. `CompanyGlobe.tsx` batches direct input into at most
one render per animation frame, with no idle animation, inertia or transitions.
Reduced motion therefore uses the same immediate controls and information.
