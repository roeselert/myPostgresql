-- A small synthetic catalog for the Bluebox schema.
--
-- The real Bluebox data set is an 89 MB dump of TMDB films and Geofaker
-- addresses, which is not something a browser test bed should download. This
-- file instead generates a catalog of the same shape -- stores, films,
-- inventory and customers around New York -- large enough for Bluebox's own
-- procedures to generate rentals and payments against, and small enough to
-- build in a second.
--
-- Nothing here is real: the titles are assembled from word lists and the
-- customers are random points in a 25 km ring around the stores.

SET search_path TO bluebox, public;

SELECT setseed(0.42);  -- same catalog on every run

TRUNCATE payment, rental, customer_status_log, inventory, customer, staff, store,
         film_cast, film_crew, film_genre, film_production_company, film, person,
         production_company, zip_code_info, holiday, pricing, inventory_status,
         release_type, language RESTART IDENTITY CASCADE;

-- ---------------------------------------------------------------- reference

INSERT INTO inventory_status (status_id, status_code, description, display_order) VALUES
  (1, 'available', 'In circulation and rentable', 1),
  (2, 'lost',      'Never returned, charged to the customer', 2),
  (3, 'damaged',   'Returned unusable', 3),
  (4, 'retired',   'Taken out of circulation', 4);

INSERT INTO release_type (release_type_id, release_type) VALUES
  (1, 'Premiere'), (2, 'Theatrical (limited)'), (3, 'Theatrical'),
  (4, 'Digital'), (5, 'Physical'), (6, 'TV');

INSERT INTO language (name) VALUES ('English'), ('German'), ('French'), ('Spanish'), ('Japanese');

-- The keys bluebox.get_pricing() looks up; see get_replacement_cost().
INSERT INTO pricing (pricing_key, pricing_value, description) VALUES
  ('daily_rental_rate',        2.49, 'Charged per day of a rental'),
  ('replacement_cost_new',     24.99, 'Film released within the last year'),
  ('replacement_cost_recent',  19.99, 'Released within the last three years'),
  ('replacement_cost_catalog', 14.99, 'Released within the last ten years'),
  ('replacement_cost_classic',  9.99, 'Older than ten years');

-- US federal holidays, which generate_rentals() uses to raise the rental rate.
INSERT INTO holiday (id, holiday_name, is_paid_time_off, holiday_date)
SELECT row_number() OVER (), h.name, true,
       make_date(y.year, h.month, h.day)
FROM generate_series(extract(year FROM CURRENT_DATE)::int - 1,
                     extract(year FROM CURRENT_DATE)::int + 1) AS y(year),
     (VALUES ('New Year''s Day', 1, 1), ('Independence Day', 7, 4),
             ('Veterans Day', 11, 11), ('Christmas Day', 12, 25)) AS h(name, month, day);

-- ------------------------------------------------------------------- stores

INSERT INTO zip_code_info (zip_code, lat, lng, city, state_id, state_name, population, geog) VALUES
  (10001, 40.7506, -73.9972, 'New York',  'NY', 'New York',  27004, point(-73.9972, 40.7506)),
  (11201, 40.6941, -73.9898, 'Brooklyn',  'NY', 'New York',  63000, point(-73.9898, 40.6941)),
  (11101, 40.7505, -73.9370, 'Long Island City', 'NY', 'New York', 38000, point(-73.9370, 40.7505)),
  (10453, 40.8526, -73.9120, 'Bronx',     'NY', 'New York',  78000, point(-73.9120, 40.8526)),
  (10301, 40.6323, -74.0891, 'Staten Island', 'NY', 'New York', 35000, point(-74.0891, 40.6323));

INSERT INTO store (store_id, street_name, road_ref, phone, zip_code, geog) VALUES
  (1, 'W 31st St',      'NY-495', '212-555-0101', 10001, point(-73.9972, 40.7506)),
  (2, 'Atlantic Ave',   'NY-27',  '718-555-0102', 11201, point(-73.9898, 40.6941)),
  (3, 'Jackson Ave',    'NY-25A', '718-555-0103', 11101, point(-73.9370, 40.7505)),
  (4, 'Grand Concourse','NY-1',   '718-555-0104', 10453, point(-73.9120, 40.8526)),
  (5, 'Bay St',         'NY-440', '718-555-0105', 10301, point(-74.0891, 40.6323));

SELECT setval(pg_get_serial_sequence('bluebox.store', 'store_id'), 5, true)
WHERE pg_get_serial_sequence('bluebox.store', 'store_id') IS NOT NULL;

INSERT INTO staff (first_name, last_name, address_id, email, store_id, username)
SELECT n.first, n.last, s.store_id, lower(n.first || '.' || n.last) || '@bluebox.example',
       s.store_id, lower(left(n.first, 1) || n.last)
FROM store s
CROSS JOIN LATERAL (VALUES ('Ada', 'Lovelace'), ('Grace', 'Hopper')) AS n(first, last);

-- -------------------------------------------------------------------- films

-- 240 titles assembled from word lists, released across the last 25 years.
INSERT INTO film (film_id, title, overview, release_date, original_language, rating,
                  popularity, vote_count, vote_average, budget, revenue, runtime)
SELECT g,
       initcap(a.word) || ' ' || initcap(b.word),
       'A ' || a.word || ' story about ' || b.word || ', told across ' ||
         (80 + (random() * 70)::int) || ' minutes.',
       (CURRENT_DATE - ((random() * 25 * 365)::int))::date,
       'en',
       (ARRAY['G', 'PG', 'PG-13', 'R', 'NC-17', 'NR'])[1 + (random() * 5)::int]::public.mpaa_rating,
       (random() * 100)::real,
       (random() * 5000)::int,
       (5 + random() * 5)::real,
       (1e6 * (1 + random() * 200))::bigint,
       (1e6 * (1 + random() * 900))::bigint,
       80 + (random() * 70)::int
FROM generate_series(1, 240) g
CROSS JOIN LATERAL (
  SELECT (ARRAY['silent', 'crimson', 'northern', 'electric', 'hollow', 'distant',
                'golden', 'winter', 'paper', 'iron', 'quiet', 'last'])[1 + (g % 12)]
) AS a(word)
CROSS JOIN LATERAL (
  SELECT (ARRAY['harbour', 'engine', 'orchard', 'signal', 'canyon', 'lantern',
                'atlas', 'meridian', 'circuit', 'foxtrot', 'hollow', 'tide',
                'archive', 'kestrel', 'pioneer', 'drifter', 'anchor', 'beacon',
                'cipher', 'ember'])[1 + ((g / 12) % 20)]
) AS b(word);

SELECT setval(pg_get_serial_sequence('bluebox.film', 'film_id'), 240, true)
WHERE pg_get_serial_sequence('bluebox.film', 'film_id') IS NOT NULL;

-- ---------------------------------------------------------------- inventory

-- Every film gets 2-8 copies, spread over the five stores.
INSERT INTO inventory (film_id, store_id, status_id, circulation_start)
SELECT f.film_id,
       1 + (random() * 4)::int,
       1,
       now() - ((random() * 900)::int || ' days')::interval
FROM film f
CROSS JOIN LATERAL generate_series(1, 2 + (random() * 6)::int) AS copy;

-- ---------------------------------------------------------------- customers

-- 900 customers, each a random point within 20 km of the store they belong to.
INSERT INTO customer (customer_id, store_id, full_name, email, phone, zip_code,
                      activebool, create_date, geog)
SELECT g,
       s.store_id,
       initcap(f.word) || ' ' || initcap(l.word),
       'customer' || g || '@example.com',
       '212-555-' || lpad((1000 + g)::text, 4, '0'),
       s.zip_code,
       random() > 0.05,                                   -- ~5% inactive
       (CURRENT_DATE - (random() * 1500)::int)::date,
       point((s.geog::point)[0] + (random() - 0.5) * 0.45,  -- ~±19 km of longitude
             (s.geog::point)[1] + (random() - 0.5) * 0.34)  -- ~±19 km of latitude
FROM generate_series(1, 900) g
CROSS JOIN LATERAL (SELECT * FROM store ORDER BY (g * 7919 + store_id) % 5 LIMIT 1) s
CROSS JOIN LATERAL (
  SELECT (ARRAY['mara', 'joel', 'ines', 'kofi', 'petra', 'anil', 'rosa', 'tomas',
                'lena', 'hugo', 'sana', 'bjorn'])[1 + (g % 12)]
) AS f(word)
CROSS JOIN LATERAL (
  SELECT (ARRAY['keller', 'navarro', 'okafor', 'lindqvist', 'moreau', 'brandt',
                'silva', 'novak', 'ferreira', 'haas', 'mbeki', 'ricci',
                'santos', 'weber', 'dubois'])[1 + ((g / 12) % 15)]
) AS l(word);

SELECT setval(pg_get_serial_sequence('bluebox.customer', 'customer_id'), 900, true)
WHERE pg_get_serial_sequence('bluebox.customer', 'customer_id') IS NOT NULL;

ANALYZE;
