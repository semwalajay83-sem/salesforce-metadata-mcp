# Agentforce Guide

Complete guide for creating Agentforce agents with `salesforce-metadata-mcp`.

---

## Overview

Agentforce (Einstein Copilot) agents consist of four components deployed in this order:

1. **Agent** (`Bot`) — The AI assistant shell with persona and tone
2. **Actions** (`GenAiFunction`) — Concrete steps powered by Flows, Apex, or Prompt Templates
3. **Topics** (`GenAiPlugin`) — Areas of expertise; each topic lists which actions it can invoke
4. **Planner** (`GenAiPlanner`) — **The critical wiring step** that connects the agent to its topics

> **Why the planner matters:** Without step 4, the agent exists in Salesforce but has zero routing capability. It cannot reach any topic or action. `sf_create_agent_planner` is what makes the agent functional.

---

## Step 1: Create the Agent

```
Create an Agentforce agent called SalesAssistant:
- Label: Sales Assistant
- Persona: A knowledgeable sales expert who helps reps close more deals
- Tone: Professional
```

This calls `sf_create_agent` with:
```json
{
  "agentName": "SalesAssistant",
  "label": "Sales Assistant",
  "persona": "A knowledgeable sales expert who helps reps close more deals",
  "tone": "Neutral"
}
```

---

## Step 2: Create a Flow for Each Action

Create the Flow that the agent will invoke:

```
Create an AutoLaunchedFlow called Get_Account_Orders that:
- Takes an input variable accountId (String, isInput: true)
- Queries related Order__c records using GetRecords
- Returns them in an output variable orders (SObject collection, isOutput: true)
```

---

## Step 3: Create Actions

Create a `GenAiFunction` linked to each Flow. **Note the action name — you'll need it in Step 4.**

```
Create an agent action called GetOrders for the SalesAssistant agent's OrderManagement topic:
- Type: Flow
- Reference: Get_Account_Orders
- Description: Retrieves all orders for a given account
```

This calls `sf_create_agent_action`. The action is deployed as a standalone `GenAiFunction` — it gets linked to the topic in the next step.

---

## Step 4: Create Topics (with actions listed)

Topics are created with their actions already listed. This is what links actions to topics.

```
Add a topic called OrderManagement to the SalesAssistant agent:
- Label: Order Management
- Description: Handles all questions about customer orders, quotes, and order status
- Scope: User questions about creating orders, checking order status, updating order quantities
- Instructions: 1. Identify the order or account. 2. Check current status. 3. Take appropriate action.
- Actions: ["GetOrders"]
```

This calls `sf_create_agent_topic` with `actions: ["GetOrders"]` — this embeds `<genAiFunctions>` in the topic XML.

---

## Step 5: Wire the Agent to its Topics (the Planner)

This is the step that was previously missing. Call `sf_create_agent_planner` after all topics are created:

```
Wire the SalesAssistant agent to its topics: OrderManagement
```

This calls `sf_create_agent_planner` with:
```json
{
  "agentName": "SalesAssistant",
  "label": "Sales Assistant",
  "topicNames": ["OrderManagement"]
}
```

This deploys a `GenAiPlanner` record that routes user requests from the agent to the correct topic.

> If you add more topics later, call `sf_create_agent_planner` again with the **full updated list** of topic names — it will overwrite the planner with the new configuration.

---

## End-to-End Example

Full conversation to create a support agent:

```
1. Create an Agentforce agent called SupportAgent with:
   - Persona: "A friendly and efficient customer support representative"
   - Tone: Formal
   - Company: Acme Corp

2. Create an AutoLaunchedFlow called Create_Support_Case with:
   - Input variables: subject (String), description (String), contactId (String)
   - A CreateRecords element creating a Case with inputAssignments for those fields
   - Output variable: caseId (String)

3. Create an agent action CreateCase for SupportAgent.CaseManagement:
   - Type: Flow
   - Reference: Create_Support_Case
   - Description: Creates a new support case for the customer

4. Add a topic CaseManagement to SupportAgent:
   - Description: Handles customer support cases, status inquiries, and escalations
   - Scope: Questions about case status, creating new cases, escalating urgent issues
   - Actions: ["CreateCase"]

5. Wire SupportAgent to its topics:
   - topicNames: ["CaseManagement"]
```

---

## Testing Your Agent

After completing all steps:

1. **Activate the agent** in Setup → Agents → Your Agent → Activate
2. **Open Copilot** in any Salesforce page (the lightning bolt icon)
3. **Test a prompt:** "I need to create a support case for a billing issue"

The agent should route to the CaseManagement topic and invoke the CreateCase action.

---

## Tips

- **Create actions before topics** — topics need to list their action names upfront
- **Always run sf_create_agent_planner last** — it's the step that activates routing
- **Adding a new topic?** Re-run `sf_create_agent_planner` with all topic names (existing + new)
- **Be specific in topic descriptions** — the AI uses them to route requests
- **Use clear action descriptions** — help the agent know when to invoke each action
- **Start with Flows** — they're easiest to create and debug
