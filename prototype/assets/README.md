# Globe assets

`world-countries.json` contains simplified country and territory boundaries from Natural Earth’s public-domain 1:50m dataset (excluding Antarctica). Coordinates retain their spherical geometry; polygon winding is normalized for D3. Stored country centers select a company-specific starting orientation.

- [Natural Earth source](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_50m_admin_0_countries.geojson)
- [Public-domain terms](https://www.naturalearthdata.com/about/terms-of-use/)

The globe uses locally bundled `d3-array` 3.2.4 and `d3-geo` 3.1.1. Their ISC licenses are included beside the minified distributions in `vendor/`.

The orthographic projection renders in a square SVG with a fixed scale, so the sphere never stretches. Wheel input over the sphere rotates longitude; dragging and keyboard arrows also rotate. Home restores the starting orientation. There is no zoom, automatic rotation, legend or explanatory note. Vertical touch gestures retain page scrolling. Active countries derive from current sample job locations; vague regions are not expanded into country claims. Assets load locally, and the reserved graphic space prevents layout shifts.
