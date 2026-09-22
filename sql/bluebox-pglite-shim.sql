-- PostGIS shim for the Bluebox schema under PGlite.
--
-- Bluebox needs PostGIS for three things only: a `geography(Point,4326)`
-- column on customer, store and zip_code_info, `ST_DWithin()` to find
-- customers near a store, and a GiST index over those points. PGlite has no
-- PostGIS, so this file provides the smallest stand-in that keeps the
-- upstream SQL working unchanged:
--
--   * `public.geography` as a domain over the built-in `point` type, holding
--     (longitude, latitude) in degrees. The build step rewrites the column
--     type `public.geography(Point,4326)` to `public.geography`, because a
--     domain cannot carry a type modifier.
--   * `ST_DWithin()` and `ST_Distance()` over those points, on a spherical
--     earth. Same name, same argument order, metres as the unit — so every
--     call site in Bluebox resolves to these without being touched.
--
-- What this is not: a projection-aware, ellipsoidal implementation. Distances
-- are haversine on a sphere of radius 6371008.8 m, which is off by up to
-- ~0.5% against PostGIS. That is far below the 25 km radius Bluebox uses to
-- decide which customers live near a store.

CREATE DOMAIN public.geography AS point;

COMMENT ON DOMAIN public.geography IS
  'PGlite stand-in for PostGIS geography(Point,4326): a point of (longitude, latitude) in degrees.';

-- Great-circle distance in metres between two lon/lat points.
CREATE FUNCTION public.st_distance(a public.geography, b public.geography)
RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$
  SELECT 2 * 6371008.8 * asin(sqrt(
      sin(radians((b[1] - a[1]) / 2)) ^ 2
    + cos(radians(a[1])) * cos(radians(b[1]))
      * sin(radians((b[0] - a[0]) / 2)) ^ 2
  ));
$$;

COMMENT ON FUNCTION public.st_distance(public.geography, public.geography) IS
  'Haversine distance in metres. point[0] is longitude, point[1] is latitude.';

CREATE FUNCTION public.st_dwithin(
  a public.geography,
  b public.geography,
  distance double precision
)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$
  SELECT public.st_distance(a, b) <= distance;
$$;

-- Constructors, so seed data and ad hoc queries read like PostGIS.
CREATE FUNCTION public.st_makepoint(longitude double precision, latitude double precision)
RETURNS public.geography
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$
  SELECT point(longitude, latitude)::public.geography;
$$;

CREATE FUNCTION public.st_setsrid(geog public.geography, srid integer)
RETURNS public.geography
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$
  SELECT geog;
$$;

CREATE FUNCTION public.st_x(geog public.geography) RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$ SELECT (geog::point)[0] $$;

CREATE FUNCTION public.st_y(geog public.geography) RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$ SELECT (geog::point)[1] $$;
