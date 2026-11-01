-- phase: expand
-- A company page filters by the slug computed from the board's spelling (server/jobs/companies.js SLUG_SQL). Without an
-- index every query folds all ~15k listings: four such scans made /companies/:slug take ~0.24 s. The expression is
-- immutable, so PostgreSQL can store its value; old code keeps working (it simply does not use the index).
CREATE INDEX IF NOT EXISTS work_listings_company_slug ON work_listings (
    (rtrim(left(trim(both '-' from regexp_replace(translate(lower(company), 'äàáâãåāçćčďđëèéêēğïìíîīłñńňöòóôõøōřŕßśšşťţüùúûůūýÿźżžæœ', 'aaaaaaacccddeeeeegiiiiilnnnooooooorrssssttuuuuuuyyzzzao'), '[^a-z0-9]+', '-', 'g')), 80), '-'))
) WHERE expired = false;
