import assert from "node:assert/strict";
import { chromium } from "playwright";
import { runAgent } from "./src/agent/agent.js";

const browser = await chromium.launch({
  headless: true
});

let passed = 0;

async function runCase({
  name,
  html,
  label,
  operation,
  value = "",
  expectedStatus,
  verify
}) {
  const page = await browser.newPage();

  try {
    await page.setContent(html);

    const reasoner = async (_task, observation) => {
      const element = observation.actionableElements.find(
        item => item.label === label
      );

      assert.ok(element, `Missing element: ${label}`);

      return {
        ref: element.ref,
        operation,
        value
      };
    };

    const result = await runAgent(
      page,
      `Interact with ${label}`,
      {
        type: "visible_content",
        text: "TARGET_TEXT_NOT_PRESENT"
      },
      { reasoner }
    );

    assert.equal(
      result.status,
      expectedStatus,
      name
    );

    await verify(page, result);

    passed++;
    console.log("PASSED:", name);
  } finally {
    await page.close();
  }
}

try {
  await runCase({
    name: "Send Message requires approval",
    html: `
      <button
        onclick="window.sent = true"
      >Send Message</button>
    `,
    label: "Send Message",
    operation: "click",
    expectedStatus: "approval_required",
    verify: async page => {
      assert.equal(
        await page.evaluate(() => window.sent),
        undefined
      );
    }
  });

  await runCase({
    name: "Delete Account requires approval",
    html: `
      <button
        onclick="window.deleted = true"
      >Delete Account</button>
    `,
    label: "Delete Account",
    operation: "click",
    expectedStatus: "approval_required",
    verify: async page => {
      assert.equal(
        await page.evaluate(() => window.deleted),
        undefined
      );
    }
  });

  await runCase({
    name: "Password requires human handover",
    html: `
      <label for="password">Password</label>
      <input id="password" type="password">
    `,
    label: "Password",
    operation: "fill",
    value: "secret",
    expectedStatus: "human_handover_required",
    verify: async page => {
      assert.equal(
        await page.locator("#password").inputValue(),
        ""
      );
    }
  });

  await runCase({
    name: "Ordinary field remains automatic",
    html: `
      <label for="name">Full Name</label>
      <input id="name">
    `,
    label: "Full Name",
    operation: "fill",
    value: "Vivek",
    expectedStatus: "planning_stagnation",
    verify: async page => {
      assert.equal(
        await page.locator("#name").inputValue(),
        "Vivek"
      );
    }
  });

  console.log(
    `\nPRODUCTION ACTION SAFETY: ${passed}/4 PASSED`
  );
} finally {
  await browser.close();
}
