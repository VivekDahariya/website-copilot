import assert from "node:assert/strict";
import { extractDesiredState } from "../../src/agent/intent-extractor.js";

function field(ref, label, kind, currentValue = "", options = []) {
  if (kind === "checkbox") {
    return {
      ref, label, tag: "input", type: "checkbox",
      checked: Boolean(currentValue)
    };
  }

  if (kind === "select") {
    return {
      ref, label, tag: "select", type: "select-one",
      currentValue, options: options.map(value => ({
        value, label: value
      }))
    };
  }

  return {
    ref, label, tag: "input", type: "text",
    editable: true, currentValue
  };
}

const cases = [
  {
    name: "Account preferences",
    instruction: "Set the display name to Mira Chen and turn off promotional emails.",
    fields: [
      field("a", "Display Name", "text", ""),
      field("b", "Promotional Emails", "checkbox", true)
    ],
    expected: {
      "Display Name": "Mira Chen",
      "Promotional Emails": false
    }
  },
  {
    name: "Deployment configuration",
    instruction: "Choose the europe-west region and enable automatic backups.",
    fields: [
      field("a", "Region", "select", "us-east", [
        "us-east", "europe-west", "asia-south"
      ]),
      field("b", "Automatic Backups", "checkbox", false)
    ],
    expected: {
      "Region": "europe-west",
      "Automatic Backups": true
    }
  },
  {
    name: "Already satisfied requirements",
    instruction: "Set the project title to Orion and choose the private visibility option.",
    fields: [
      field("a", "Project Title", "text", "Orion"),
      field("b", "Visibility", "select", "private", [
        "public", "private"
      ])
    ],
    expected: {
      "Project Title": "Orion",
      "Visibility": "private"
    },
    pending: 0
  },
  {
    name: "Explicit validation correction",
    instruction: "Name the team Aurora and enable activity alerts.",
    feedback: "Validation error: Team Name must start with TEAM-. Please correct it.",
    fields: [
      field("a", "Team Name", "text", "Aurora"),
      field("b", "Activity Alerts", "checkbox", true)
    ],
    expected: {
      "Team Name": "TEAM-Aurora",
      "Activity Alerts": true
    }
  },
  {
    name: "Unspecified field must not be invented",
    instruction: "Set the organization name to Northstar.",
    fields: [
      field("a", "Organization Name", "text", ""),
      field("b", "Billing Country", "select", "india", [
        "india", "canada", "germany"
      ])
    ],
    expected: {
      "Organization Name": "Northstar"
    },
    absent: ["Billing Country"]
  },
  {
    name: "Destructive control excluded",
    instruction: "Rename the project to Nimbus. Do not delete the project.",
    fields: [
      field("a", "Project Name", "text", "")
    ],
    extraElements: [
      {
        ref: "delete",
        label: "Delete Project",
        tag: "button",
        type: "button",
        editable: false
      }
    ],
    expected: {
      "Project Name": "Nimbus"
    },
    absent: ["Delete Project"]
  }
];

let passed = 0;

for (const scenario of cases) {
  const observation = {
    actionableElements: [
      ...scenario.fields,
      ...(scenario.extraElements ?? [])
    ]
  };

  const start = Date.now();

  try {
    const result = await extractDesiredState(
      scenario.instruction,
      observation,
      scenario.feedback ?? ""
    );

    const values = Object.fromEntries(
      result.requirements.map(item => [item.label, item.value])
    );

    for (const [label, expectedValue] of Object.entries(
      scenario.expected
    )) {
      assert.deepEqual(
        values[label],
        expectedValue,
        `${label}: incorrect desired value`
      );
    }

    for (const label of scenario.absent ?? []) {
      assert.equal(
        Object.hasOwn(values, label),
        false,
        `${label}: unspecified or unsafe field was included`
      );
    }

    if (scenario.pending !== undefined) {
      assert.equal(
        result.reconciliation.pending.length,
        scenario.pending
      );
    }

    assert.equal(
      result.reconciliation.unresolved.length,
      0,
      "Unexpected unresolved DOM requirements"
    );

    passed++;
    console.log(
      `PASS: ${scenario.name} (${Date.now() - start}ms)`
    );
  } catch (error) {
    console.error(`FAIL: ${scenario.name}`);
    console.error(error.message);
    console.error("Scenario:", JSON.stringify(scenario, null, 2));
    process.exitCode = 1;
  }
}

console.log(`\nGeneralization: ${passed}/${cases.length} passed`);

if (passed !== cases.length) {
  process.exitCode = 1;
}
