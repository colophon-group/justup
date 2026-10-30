# Map shapes

`world-map.svg` is generated from Natural Earth's 1:50m country boundaries:

- Source: https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_50m_admin_0_countries.geojson
- Public-domain terms: https://www.naturalearthdata.com/about/terms-of-use/

The asset contains simplified country and territory paths in a level, north-up world view. Camera bounds derive from each company’s active hiring countries rather than a fixed Europe crop. Regional framing uses the main landmass to avoid faraway islands forcing an unnecessary world view; geographically broad and unknown footprints use the full world. It is loaded locally, has a reserved size to avoid layout shifts, and is decorative rather than an interactive information graphic. Active countries are colored from the sample company's current job locations; vague regions are not expanded into country claims. No legend or explanatory note appears in the interface.
