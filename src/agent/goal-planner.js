const OLLAMA_URL = "http://127.0.0.1:11434/api/chat";
const MODEL = process.env.COPILOT_OLLAMA_MODEL || "qwen3:4b";

export async function planGoal(task, initialUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  let response;

  try {
    response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        think: false,
        keep_alive: "10m",
        options: {
          temperature: 0,
          num_ctx: 2048
        },
        format: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [
                "page_destination",
                "visible_content",
                "form_state",
                "all_of",
                "unsupported"
              ]
            },
            hostname: { type: "string" },
            pathname: { type: "string" },
            heading: { type: "string" },
            text: { type: "string" },
            fieldLabel: { type: "string" },
            expectedValue: { type: "string" },
            conditions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: [
                      "page_destination",
                      "visible_content",
                      "form_state"
                    ]
                  },
                  hostname: { type: "string" },
                  pathname: { type: "string" },
                  heading: { type: "string" },
                  text: { type: "string" },
                  fieldLabel: { type: "string" },
                  expectedValue: { type: "string" }
                },
                required: [
                  "type",
                  "hostname",
                  "pathname",
                  "heading",
                  "text",
                  "fieldLabel",
                  "expectedValue"
                ]
              }
            }
          },
          required: [
            "type",
            "hostname",
            "pathname",
            "heading",
            "text",
            "fieldLabel",
            "expectedValue",
            "conditions"
          ]
        },
        messages: [
          {
            role: "system",
            content: `You are Website CoPilot's goal planner.

Convert a browser task into an independently verifiable goal.

Supported goal types:

1. page_destination
Use when the task requires opening a specific destination.

IMPORTANT:
initialUrl is the STARTING page, NOT the target destination.
Never copy initialUrl into the destination unless the user
explicitly wants to remain on that page.

For English Wikipedia articles:
- hostname must be en.wikipedia.org
- pathname must be /wiki/Article_Title
- replace spaces in article titles with underscores
- heading must be the article title

Example:
Task: Open Ada Lovelace's Wikipedia article.
initialUrl: https://www.wikipedia.org/

Correct destination:
hostname: en.wikipedia.org
pathname: /wiki/Ada_Lovelace
heading: Ada Lovelace

Incorrect destination:
hostname: www.wikipedia.org
pathname: /wiki

For other websites, only specify a destination when it
can be reliably derived from the task.
Never invent unknown destination URLs.

2. visible_content
Use when the task asks to find or display specific text.

Extract ONLY the actual text the user wants to find.

Do not include instruction phrases such as:
- on this page
- in this website
- please find
- look for
- search for

Example:
Task: Find the text This domain is for use in documentation examples on this page.
Expected text: This domain is for use in documentation examples

Example:
Task: Find the phrase Account Settings on this page.
Expected text: Account Settings

The text must be supported by the user's request.
Do not invent or append words.

3. form_state
Use when the task asks to fill a particular field.
Set fieldLabel and expectedValue.

4. all_of
Use when the task explicitly requires multiple independent
success conditions.

Example:
Task: Open Alan Turing's Wikipedia article and confirm that
the page contains the heading Early life and education.

Return an all_of goal containing:
- page_destination for the Alan Turing article
- visible_content for Early life and education

IMPORTANT COMPOSITE RULE:
Each condition must describe its own verification target.

For a page_destination condition:
- Use the FINAL destination URL.
- Do not use the starting page URL.
- Do not use a generic website homepage.
- Do not use /wiki when a specific article is requested.

For a visible_content condition:
- Set text to the exact requested content.
- Leave hostname, pathname and heading empty unless needed.

The top-level hostname, pathname, heading, text,
fieldLabel and expectedValue must all be empty strings
when type is all_of.

Use at most 5 conditions.

5. unsupported
Use when no reliable completion condition can be derived.

Rules:
- Never claim a task is already complete.
- Never invent evidence.
- Choose exactly one goal type.
- Use empty strings for unused properties.
- Do not generate goals for payments, purchases, deletions, or consequential submissions.
- Return JSON only.`
          },
          {
            role: "user",
            content: JSON.stringify({
              task,
              initialUrl
            })
          }
        ]
      })
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Ollama HTTP error: ${response.status}`);
  }

  const result = await response.json();

  if (!result.message?.content) {
    throw new Error("Goal planner returned no content.");
  }

  const goal = JSON.parse(result.message.content);

  if (
    !goal ||
    ![
      "page_destination",
      "visible_content",
      "form_state",
      "all_of",
      "unsupported"
    ].includes(goal.type)
  ) {
    throw new Error("Invalid generated goal.");
  }

  for (const key of [
    "hostname",
    "pathname",
    "heading",
    "text",
    "fieldLabel",
    "expectedValue"
  ]) {
    if (typeof goal[key] !== "string") {
      throw new Error(`Invalid goal property: ${key}`);
    }
  }

  if (goal.type === "all_of") {
    if (
      !Array.isArray(goal.conditions) ||
      goal.conditions.length < 2 ||
      goal.conditions.length > 5
    ) {
      throw new Error("Invalid composite goal conditions.");
    }

    for (const condition of goal.conditions) {
      if (
        !condition ||
        ![
          "page_destination",
          "visible_content",
          "form_state"
        ].includes(condition.type)
      ) {
        throw new Error("Invalid composite condition type.");
      }
    }
  }

  return goal;
}
