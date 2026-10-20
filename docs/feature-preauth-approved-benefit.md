# Feature proposal: pre-authorisation and ApprovedBenefit

**Status:** draft for community discussion  
**Modules:** `claim`, `product`, `api_fhir_r4`, a new `benefit` module, `ClaimModule` (frontend)  
**Audience:** openIMIS developers and implementers  
**Depends on:** [Auditable claim review](feature-claim-review.md) (required)  
**Builds on:** [Price lists as facility agreements](feature-price-list-agreements.md) (optional)

## Summary

Some care must be approved before it is given. Today openIMIS has no way to say
which items need that approval, and no record of what was approved.

- A **pre-authorisation** is a claim with `use = preauthorization`. It is
  reviewed like any claim, with the split review.
- Product coverage says which items and services **need pre-authorisation**.
- When a pre-authorisation is final, each approved line creates an
  **`ApprovedBenefit`**: who, what, how much, until when.
- The automatic check of a later claim **uses up** a matching `ApprovedBenefit`
  before checking product coverage. A line that needs pre-authorisation and has
  none is rejected.

---

## 1. What exists today

| | Where | Problem |
|---|---|---|
| Pre-authorisation | `Claim.pre_authorization` boolean (`claim/models.py:267`) | Only set and filtered on. No logic uses it. |
| Coverage | Product item/service coverage | No "needs pre-authorisation" setting. |
| Benefit tracking | `ClaimDedRem` (`claim/models.py:820`), with fixed columns `ded_g/op/ip`, `rem_g/op/ip` | The categories are fixed in the columns, so new kinds of benefit cannot be tracked. |
| Benefit payments | `BenefitConsumption` (`payroll/models.py:111`) | A payment to an `Individual` (receipt, due date, amount), not an entitlement to care. Used by 5 modules. |

## 2. Goals and non-goals

**Goals**

- Mark items and services that need pre-authorisation, per product.
- Record what was approved, and use it up across one or several claims.
- Reject care that needed pre-authorisation and did not have it.

**Non-goals**

- Medical justification (a prescription, for example).
- "Rights": benefits that recur over time (pensions, sickness compensation).
  A future RFC; they will be another source of `ApprovedBenefit`.
- Replacing `ClaimDedRem` with `ApprovedBenefit` uses: future RFC.

## 3. Claim use

`Claim.use`: `claim` | `preauthorization` | `predetermination`, as in FHIR. It
replaces the `pre_authorization` boolean; `true` is migrated to
`preauthorization`. On FHIR it is `Claim.use`; GraphQL gets separate mutations.

A pre-authorisation can carry a **target date**, for care planned in the future.

## 4. Product setting

Product item/service coverage gets a **"needs pre-authorisation"** flag. It is a
coverage rule, so it belongs on the product: the same drug can need it under one
product and not under another.

## 5. `ApprovedBenefit`

A pre-authorisation is reviewed like any claim. When it is final, every approved
line creates an `ApprovedBenefit`:

| Field | Notes |
|---|---|
| insuree, product | Product, not policy (see validity). |
| `line_content_type`, item/service | What was approved. |
| quantity, unit price / amount | As approved. |
| `valid_from`, `valid_to` | From the pre-authorisation's target date. |
| source review, `line_ref` | Where the benefit came from (split review RFC). |
| agreement *(optional)* | The facility agreement it was approved under, if the price-list RFC is in place. |

**Uses**: one row per claim line that uses the benefit, with quantity, amount and
status:

- **reserved** when the claim is checked;
- **confirmed** when the claim is final;
- **released** if the line is later rejected or the claim is returned
  (`CHALLENGED`).

The benefit is locked while a use is reserved, so two claims cannot both take the
last unit.

**Where it lives:** a new `benefit` module, because openIMIS is a benefit
management system and other areas will need it. Payroll's `BenefitConsumption`
is not reused: it is a payment, not an entitlement, and moving it would affect
5 modules.

## 6. Rules

1. **The automatic check** first uses up a matching `ApprovedBenefit` (same
   insuree, item, product, within validity), then checks product coverage. It
   only ever uses `ApprovedBenefit`. When the real claim is the next version of
   the pre-authorisation, that link is kept for history and display only.
2. **Missing pre-authorisation.** A line that needs pre-authorisation and has no
   `ApprovedBenefit` is rejected with a **new reason code** (22 onwards).
3. **Validity.** Nothing carries over. When the claim is checked, the insuree
   must hold an active policy **with the same product** on the date of service.
   The policy may be a renewal; the renewal flag is not relied on.
4. **Processing.** A line covered by an `ApprovedBenefit` is priced at the
   approved price instead of the price list. Deductibles and ceilings still
   apply, because the product defines them.

## 7. With facility agreements (optional)

If price lists move to facility agreements, this RFC can use them:

- the approved price can default to the agreement's price on the target date;
- an `ApprovedBenefit` can be limited to the agreement it was approved under,
  so it is not used up at another facility.

Neither is needed for this RFC to work.

## 8. FHIR mapping

| openIMIS | FHIR | Notes |
|---|---|---|
| `Claim.use` | `Claim.use` | |
| `ApprovedBenefit` | `ClaimResponse.preAuthRef` / `preAuthPeriod` | On the pre-authorisation's response. |
| use of a benefit | `Claim.insurance.preAuthRef` | On the later claim, when the facility gives it. |

## 9. Open questions

1. Is a benefit limited to the facility (or agreement) that requested it, or
   usable at any facility?
2. Can a pre-authorisation be partly approved (less quantity than requested),
   and does the facility then see the difference before giving care?

## 10. Definition of done

```gherkin
Feature: Pre-authorisation and ApprovedBenefit

  Scenario: A line that needs pre-authorisation without one is rejected
    Given the product requires pre-authorisation for item "X"
    And the insuree has no ApprovedBenefit for "X"
    When a claim with "X" is checked
    Then line "X" is rejected with the "pre-authorisation missing" reason

  Scenario: An approved pre-authorisation creates an ApprovedBenefit
    Given a pre-authorisation for 10 units of "X" with a target date next month
    When its review approves 10 units and it becomes final
    Then an ApprovedBenefit for 10 units of "X" exists for the insuree
    And it is valid from the target date

  Scenario: A claim uses up an ApprovedBenefit
    Given an ApprovedBenefit for 10 units of "X" valid this month
    When a claim for 4 units of "X" is checked
    Then 4 units are reserved
    When the claim is valued
    Then the 4 units are confirmed and 6 remain

  Scenario: Two claims cannot take the last unit
    Given an ApprovedBenefit with 1 unit of "X" left
    When two claims for 1 unit of "X" are checked at the same time
    Then exactly one of them reserves the unit

  Scenario: A rejected line releases its use
    Given 4 units of "X" are reserved by a claim
    When a review rejects that line
    Then the 4 units are released

  Scenario: A line covered by an ApprovedBenefit still bears deductibles
    Given an ApprovedBenefit for "X" at an approved price of 100
    And the product has a deductible of 20
    When a claim with "X" is processed
    Then line "X" is priced at 100 rather than the price-list price
    And the deductible of 20 is applied

  Scenario: No carry-over outside the product's policy
    Given an ApprovedBenefit for "X" under product "P"
    And the insuree has no active policy with "P" on the date of service
    When a claim with "X" is checked
    Then the ApprovedBenefit is not used

  Scenario: The pre-authorisation boolean is migrated
    Given a claim with pre_authorization true
    When the migration runs
    Then its use is "preauthorization"
```
