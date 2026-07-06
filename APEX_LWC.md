# Apex & LWC Development Guide

Guide for writing Apex classes, triggers, test classes, and Lightning Web Components via Claude.

---

## Apex Classes

### Creating Any Apex Class

Use `sf_create_apex_class` with the full class body:

```
Create an Apex class called AccountService with:
- A static method getActiveAccounts() that returns List<Account>
- A static method updateAccountStatus(Id accountId, String status) 
- Proper error handling with custom exceptions
```

Claude will write the complete class and deploy it:

```apex
public class AccountService {
    public class AccountServiceException extends Exception {}
    
    public static List<Account> getActiveAccounts() {
        return [SELECT Id, Name, Status__c FROM Account WHERE IsActive__c = true];
    }
    
    public static void updateAccountStatus(Id accountId, String status) {
        Account acc = [SELECT Id FROM Account WHERE Id = :accountId];
        acc.Status__c = status;
        update acc;
    }
}
```

### Batch Apex

```
Create a Batch Apex class called LeadCleanupBatch that:
- Queries leads older than 2 years with status Closed
- Deletes them in batches of 200
- Sends an email report when complete
```

### Schedulable Apex

```
Create a Schedulable class called WeeklyReportScheduler that
runs the WeeklyReportBatch every Monday at 6 AM
```

### Invocable Methods (for Flows)

```
Create an Apex class called OpportunityHelper with an @InvocableMethod
called calculateScore that accepts a List<Id> of opportunity IDs
and returns a List<Decimal> of scores
```

---

## Apex Triggers

### Creating a Trigger

Use `sf_create_apex_trigger`:

```
Create an Apex trigger called ContactTrigger on Contact that fires
before insert and before update. It should:
- Capitalize the first letter of FirstName and LastName
- Set Description to 'Created by trigger' on insert if empty
```

The trigger declaration is auto-generated. Just provide the body logic:

```apex
// Trigger body (goes inside the trigger { })
List<Contact> contacts = Trigger.new;
for (Contact c : contacts) {
    if (c.FirstName != null) {
        c.FirstName = c.FirstName.substring(0,1).toUpperCase() + c.FirstName.substring(1).toLowerCase();
    }
    if (Trigger.isInsert && String.isBlank(c.Description)) {
        c.Description = 'Created by trigger';
    }
}
```

---

## Apex Test Classes

### Creating a Test Class

```
Create a test class for AccountService called AccountServiceTest with:
- Test method for getActiveAccounts returning correct results
- Test method for updateAccountStatus with valid and invalid IDs
- At least 90% code coverage
- @TestSetup method for test data
```

### Running Tests After Deployment

Set `runAfterDeploy: true` in `sf_create_apex_test_class` to automatically run tests:

```
Create a test class AccountServiceTest and run it immediately after deployment
```

### Running Existing Tests

Use `sf_run_apex_tests`:

```
Run the test classes AccountServiceTest and ContactTriggerTest and show me the results
```

---

## Execute Anonymous Apex

Use `sf_execute_anonymous_apex` for one-off scripts:

```
Execute this Apex to backfill the Description field for all Accounts
that are missing it: set it to "Auto-populated"
```

```
Run anonymous Apex: query all Opportunities where StageName is 'Closed Won' 
and Amount > 100000, then print their names to the debug log
```

---

## Lightning Web Components

### Creating an LWC

Use `sf_create_lwc` with all three files:

```
Create an LWC called accountDashboard:
- HTML: Show a card with account name, phone, industry, and annual revenue
- JS: Import from LDS using @wire(getRecord) with the record ID
- Make it available on Record Pages
- Use SLDS styling
```

Claude will generate:

**HTML (accountDashboard.html):**
```html
<template>
    <lightning-card title="Account Dashboard" icon-name="standard:account">
        <div class="slds-p-horizontal_small">
            <template if:true={account.data}>
                <p><strong>Name:</strong> {accountName}</p>
                <p><strong>Phone:</strong> {accountPhone}</p>
            </template>
        </div>
    </lightning-card>
</template>
```

**JS (accountDashboard.js):**
```javascript
import { LightningElement, api, wire } from 'lwc';
import { getRecord, getFieldValue } from 'lightning/uiRecordApi';
import NAME_FIELD from '@salesforce/schema/Account.Name';
import PHONE_FIELD from '@salesforce/schema/Account.Phone';

export default class AccountDashboard extends LightningElement {
    @api recordId;
    
    @wire(getRecord, { recordId: '$recordId', fields: [NAME_FIELD, PHONE_FIELD] })
    account;
    
    get accountName() { return getFieldValue(this.account.data, NAME_FIELD); }
    get accountPhone() { return getFieldValue(this.account.data, PHONE_FIELD); }
}
```

### LWC for Flow Screens

```
Create an LWC called addressInput for use in Flow Screens:
- Inputs: street, city, state, zipCode (all @api properties)
- Outputs: the same fields after user input
- Use lightning-input components
- Target: lightning__FlowScreen
```

### Updating an LWC

```
Update the accountDashboard LWC to also show Annual Revenue and
add a button that opens a modal when clicked
```

---

## Best Practices

1. **Always write test classes** — Salesforce requires 75% coverage for production deploys
2. **Use `@TestSetup`** — Create shared test data once, reuse across all test methods
3. **Bulk-safe triggers** — Always write triggers that handle collections, not single records
4. **Use LDS in LWC** — Lightning Data Service (`@wire(getRecord)`) is more efficient than Apex calls
5. **Separate concerns** — Put business logic in service classes, keep triggers thin
6. **Handle exceptions** — Always use try-catch in Apex methods that do DML or callouts
