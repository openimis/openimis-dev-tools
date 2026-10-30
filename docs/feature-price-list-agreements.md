# Feature proposal: price lists as facility agreements

**Status:** draft for community discussion  
**Modules:** `location`, `medical_pricelist`, `claim`, `tools`, `api_fhir_r4`, `core` (reports), frontend `LocationModule`  
**Audience:** openIMIS developers and implementers  
**Used by:** [Pre-authorisation and ApprovedBenefit](feature-preauth-approved-benefit.md) (optional)  
**See also:** [Auditable claim review](feature-claim-review.md)

## Summary

A price list is an agreement between the scheme and a health facility: the
facility is accredited to provide care at these prices, for this period, and
sometimes only for some products. Today it is two attributes of the facility.

This RFC moves it to a **`FacilityAgreement`**: a link between a facility and
its price lists, with **validity dates** and an optional **product**. A facility
can then have several agreements over time, and different ones per product. The
claim check prices each line with the agreement valid **on the date of service**.

---

## 1. What exists today

| | Where | Problem |
|---|---|---|
| Price lists on the facility | `HealthFacility.items_pricelist`, `services_pricelist` (`location/models.py:553`, `:561`) | One price list of each kind per facility, with no dates and no product scope. |
| Accreditation | `HealthFacility.contract_start_date`, `contract_end_date`, `status` (`location/models.py:572-580`) | One period per facility. The dates are only checked when the facility is saved (`location/services.py:169-177`); the claim check does not use them. |
| Claim pricing | `claim/validations.py:309-322` and `:1114-1133` | Takes the facility's **current** price list, then the price valid on the claim's target date. If the facility changed price list after the care was given, a claim checked later is priced with the new list. |
| Other readers | `tools` (facility extracts, `serializers.py:62-66`, import `services.py:900-912`), `core` reports (`user_activity.py`, `registers_status.py`), `core/serializers.py:49-50` | All expect one price list per facility. |
| Legacy SQL | Stored procedures and reports reading `tblHF.PLItemID` / `PLServiceID` | **Not checked.** |

## 2. Goals and non-goals

**Goals**

- A facility's price lists have validity dates, and can change over time
  without repricing past care.
- An agreement can be limited to one product (a price list negotiated for one
  scheme or programme).
- The claim check uses the agreement valid on the date of service, for the
  product the claim is covered by.
- Accreditation dates live with the agreement, so care outside an agreement can
  be rejected.

**Non-goals**

- Changing price lists themselves (their details and relative prices).
- Merging item and service price lists: that follows the item/service merge.
- Policyholder contracts (`contract` module), which are a different agreement.

## 3. Model

### `FacilityAgreement`

| Field | Notes |
|---|---|
| `health_facility` | |
| `items_pricelist`, `services_pricelist` | Either may be empty: an agreement can cover only services. |
| `product` | Optional. Empty means all products. |
| `valid_from`, `valid_to` | The accreditation period. `valid_to` may be empty (open-ended). |
| `status` | `DRAFT`, `ACTIVE`, `SUSPENDED`, `TERMINATED`. |
| `code`, `reference` | The agreement's identifier, and an external reference (a signed contract). |

It is an `OpenIMISBusinessModel`: changing an agreement makes a new version, and
the audit is kept separately.

## 4. Rules

1. **Which agreement prices a line.** The agreement of the claim's facility that
   is `ACTIVE` on the **date of service**, for the product of the policy covering
   the line. An agreement for that product wins over one for all products.
2. **No overlap.** Two agreements of one facility with the same product scope
   (or both for all products) cannot overlap in time. This is checked on save,
   so rule 1 always finds at most one agreement per scope.
3. **No agreement.** A line with no agreement on its date of service is rejected
   with a **new rejection reason** ("facility not accredited"), unless the
   scheme setting allows it (for a transition period).
4. **Item not in the price list.** Unchanged: rejected as today.
5. **Past care keeps its prices.** Ending or replacing an agreement never
   reprices a claim whose date of service falls in the earlier agreement.

## 5. Migration and rollout

| Step | What | Rollback |
|---|---|---|
| **A. Create agreements** | One agreement per facility, for all products, with the facility's two price lists, `valid_from`/`valid_to` from its contract dates (open-ended if empty), `ACTIVE` if the facility is active. | Drop the table; the facility fields are untouched. |
| **B. Switch readers** | The claim check uses rule 1. The facility screen shows its agreements. `tools`, reports and FHIR read the agreement valid today. The facility fields are kept up to date from the current all-products agreement, so legacy SQL keeps working. | Per reader. |
| **C. Drop the facility fields** | Once every reader, including legacy SQL, has switched. | None after the drop. |

## 6. Offline and mobile

The facility extract (`tools`) carries one price list per facility today. With
agreements it must carry **each agreement valid on the extract date**, with its
product scope. The mobile claim app prices locally, so it needs the same rule 1.
Until the apps are updated, the extract keeps sending the current all-products
agreement's price lists in the old fields.

## 7. FHIR

The closest resources are `Contract` (the agreement) and
`InsurancePlan.network` / `OrganizationAffiliation` (who is accredited for
which plan). To be decided (open question 3).

## 8. Open questions

1. Should accreditation (status, period) and pricing be one object, or should
   accreditation be its own object that can exist without a price list?
2. Is "facility not accredited" a rejection or a warning by default?
3. FHIR resource for the agreement: `Contract` or `InsurancePlan` network.
4. Can an agreement be limited to a set of products rather than one?

## 9. Definition of done

```gherkin
Feature: Price lists as facility agreements

  Scenario: The agreement valid on the date of service prices the claim
    Given facility "F" had agreement "A1" with price list "PL1" until 31 March
    And agreement "A2" with price list "PL2" from 1 April
    When a claim for care given on 15 March is checked on 10 April
    Then its lines are priced with "PL1"

  Scenario: A product-specific agreement wins
    Given facility "F" has an all-products agreement with price list "PL1"
    And an agreement for product "P" with price list "PLP"
    When a claim covered by a policy of product "P" is checked
    Then its lines are priced with "PLP"

  Scenario: Overlapping agreements are refused
    Given facility "F" has an all-products agreement for this year
    When another all-products agreement overlapping this year is saved
    Then the save is refused

  Scenario: Care outside any agreement is rejected
    Given facility "F" has no active agreement on the date of service
    When its claim is checked
    Then every line is rejected with the "facility not accredited" reason

  Scenario: Migration creates one agreement per facility
    Given facility "F" with price lists "PLI" and "PLS" and contract dates
    When the migration runs
    Then "F" has one all-products agreement with "PLI", "PLS" and those dates
    And the facility's own price list fields are unchanged
```
