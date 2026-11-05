-- Rules that Prisma's schema language cannot express. They live in the database so that no code path
-- (API, worker, a hand-written SQL statement) can break them.

-- ---------------------------------------------------------------------------------------------
-- 1. CHECK constraints
-- ---------------------------------------------------------------------------------------------

-- The three columns that describe "who holds the seat" must agree with the status:
--   FREE: nobody. HELD: a user, a hold and a deadline. SOLD: a user, no hold, no deadline.
ALTER TABLE "event_seats" ADD CONSTRAINT "event_seats_status_columns_consistent" CHECK (
  (status = 'FREE' AND user_id IS NULL AND hold_id IS NULL AND held_until IS NULL)
  OR (status = 'HELD' AND user_id IS NOT NULL AND hold_id IS NOT NULL AND held_until IS NOT NULL)
  OR (status = 'SOLD' AND user_id IS NOT NULL AND hold_id IS NULL AND held_until IS NULL)
);

ALTER TABLE "seats" ADD CONSTRAINT "seats_row_not_empty" CHECK (length(btrim("row")) > 0);
ALTER TABLE "seats" ADD CONSTRAINT "seats_number_positive" CHECK ("number" > 0);

ALTER TABLE "events" ADD CONSTRAINT "events_title_length" CHECK (char_length(btrim(title)) BETWEEN 1 AND 200);
ALTER TABLE "events" ADD CONSTRAINT "events_description_length" CHECK (char_length(description) <= 5000);
ALTER TABLE "events" ADD CONSTRAINT "events_version_positive" CHECK (version >= 1);

ALTER TABLE "holds" ADD CONSTRAINT "holds_expires_after_creation" CHECK (expires_at > created_at);

-- ---------------------------------------------------------------------------------------------
-- 2. A seat of an event must belong to that event's hall
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION event_seats_check_hall() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT hall_id FROM seats WHERE id = NEW.seat_id) IS DISTINCT FROM
     (SELECT hall_id FROM events WHERE id = NEW.event_id) THEN
    RAISE EXCEPTION 'seat_not_in_event_hall' USING DETAIL = format('event %s, seat %s', NEW.event_id, NEW.seat_id);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER event_seats_check_hall BEFORE INSERT ON "event_seats"
  FOR EACH ROW EXECUTE FUNCTION event_seats_check_hall();

-- ---------------------------------------------------------------------------------------------
-- 3. At most 6 seats per user per event (held and still valid, plus sold)
-- ---------------------------------------------------------------------------------------------
-- Two parallel requests of the same user could each see "5 seats" and both add one. To stop that,
-- every change that gives a seat to a user first takes a lock named after (event, user). The second
-- request waits, then counts again and sees the first one's seats.
-- A hold whose deadline has passed no longer counts: its seats are free for everybody.

CREATE FUNCTION event_seats_enforce_user_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  taken integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('seat_limit:' || NEW.event_id || ':' || NEW.user_id, 0));

  SELECT count(*) INTO taken
  FROM event_seats
  WHERE event_id = NEW.event_id
    AND user_id = NEW.user_id
    AND id <> NEW.id
    AND (status = 'SOLD' OR (status = 'HELD' AND held_until > now()));

  IF taken >= 6 THEN
    RAISE EXCEPTION 'seat_limit_exceeded'
      USING DETAIL = format('user %s already has %s seats on event %s', NEW.user_id, taken, NEW.event_id);
  END IF;
  RETURN NEW;
END $$;

-- Fires only when a seat becomes HELD or SOLD for a user (not when it is freed).
CREATE TRIGGER event_seats_enforce_user_limit BEFORE INSERT OR UPDATE ON "event_seats"
  FOR EACH ROW
  WHEN (NEW.status IN ('HELD', 'SOLD') AND NEW.user_id IS NOT NULL)
  EXECUTE FUNCTION event_seats_enforce_user_limit();

-- ---------------------------------------------------------------------------------------------
-- 3b. A seat cannot be taken away from its owner, even by a buggy UPDATE without a WHERE
-- ---------------------------------------------------------------------------------------------
-- The normal way to take a seat is "UPDATE ... WHERE status = 'FREE' OR <hold expired>", which simply
-- skips seats that are not available. This trigger is the safety net behind it: if some code forgets
-- the WHERE, the statement fails instead of silently giving the seat to a second buyer.
--   * a sold seat never changes owner or status again;
--   * a seat with a valid (not expired) hold cannot be given to another user;
--   * which event and which physical seat a row stands for never changes.

CREATE FUNCTION event_seats_guard_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_id <> OLD.event_id OR NEW.seat_id <> OLD.seat_id THEN
    RAISE EXCEPTION 'seat_identity_immutable';
  END IF;
  IF OLD.status = 'SOLD' AND (NEW.status <> 'SOLD' OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    RAISE EXCEPTION 'seat_already_sold' USING DETAIL = format('event %s, seat %s', OLD.event_id, OLD.seat_id);
  END IF;
  IF OLD.status = 'HELD' AND OLD.held_until > now()
     AND NEW.status IN ('HELD', 'SOLD') AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'seat_not_available' USING DETAIL = format('event %s, seat %s', OLD.event_id, OLD.seat_id);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER event_seats_guard_transition BEFORE UPDATE ON "event_seats"
  FOR EACH ROW EXECUTE FUNCTION event_seats_guard_transition();

-- ---------------------------------------------------------------------------------------------
-- 4. Event version and "updated at" are maintained by the database
-- ---------------------------------------------------------------------------------------------
-- The API sends "UPDATE ... WHERE id = $1 AND version = $2". This trigger raises the version by one
-- when a real change is made, and ignores any version the statement tries to set itself.

CREATE FUNCTION events_bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.title, NEW.description, NEW.city, NEW.starts_at, NEW.hall_id)
     IS DISTINCT FROM (OLD.title, OLD.description, OLD.city, OLD.starts_at, OLD.hall_id) THEN
    NEW.version := OLD.version + 1;
    NEW.updated_at := now();
  ELSE
    NEW.version := OLD.version;
    NEW.updated_at := OLD.updated_at;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER events_bump_version BEFORE UPDATE ON "events"
  FOR EACH ROW EXECUTE FUNCTION events_bump_version();

-- ---------------------------------------------------------------------------------------------
-- 5. Every change of an event leaves a note in the outbox
-- ---------------------------------------------------------------------------------------------
-- The worker reads these notes and asks the web server to drop its cache. Because a trigger writes
-- them, a change made by hand in SQL is not forgotten either.

CREATE FUNCTION events_write_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  changed_id integer;
  changed_version integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    changed_id := OLD.id;
    changed_version := OLD.version;
  ELSE
    changed_id := NEW.id;
    changed_version := NEW.version;
  END IF;
  INSERT INTO outbox (type, payload)
  VALUES ('event.changed', jsonb_build_object('eventId', changed_id, 'version', changed_version, 'op', TG_OP));
  RETURN NULL;
END $$;

CREATE TRIGGER events_write_outbox_insert_delete AFTER INSERT OR DELETE ON "events"
  FOR EACH ROW EXECUTE FUNCTION events_write_outbox();

-- On update, only when the data really changed (the version trigger above raised the version).
CREATE TRIGGER events_write_outbox_update AFTER UPDATE ON "events"
  FOR EACH ROW WHEN (OLD.version IS DISTINCT FROM NEW.version)
  EXECUTE FUNCTION events_write_outbox();
