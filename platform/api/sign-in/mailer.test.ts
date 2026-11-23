import type { SendEmailCommand, SendEmailCommandOutput } from "@aws-sdk/client-sesv2";
import { describe, expect, it } from "vitest";
import { buildCodeEmail } from "./code-email.js";
import { SesCodeMailer, type SesSender } from "./mailer.js";

describe("SesCodeMailer (ticket 1.4 criterion 4)", () => {
  it("sends text and HTML from \"SSD Workshop\" <ssd-workshop@rankly.games> through ssd-workshop-email, with no Reply-To", async () => {
    const sent: SendEmailCommand[] = [];
    const client: SesSender = {
      send: async (command: SendEmailCommand): Promise<SendEmailCommandOutput> => {
        sent.push(command);
        return { $metadata: {}, MessageId: "m1" };
      },
    };
    const email = buildCodeEmail("042917");
    await new SesCodeMailer(client).send("jane@example.com", email);

    expect(sent).toHaveLength(1);
    const input = sent[0]?.input;
    expect(input).toEqual({
      FromEmailAddress: '"SSD Workshop" <ssd-workshop@rankly.games>',
      ConfigurationSetName: "ssd-workshop-email",
      Destination: { ToAddresses: ["jane@example.com"] },
      Content: {
        Simple: {
          Subject: { Data: "Your SSD Workshop sign-in code: 042917", Charset: "UTF-8" },
          Body: {
            Text: { Data: email.text, Charset: "UTF-8" },
            Html: { Data: email.html, Charset: "UTF-8" },
          },
        },
      },
    });
    expect(input?.ReplyToAddresses).toBeUndefined();
    expect(input?.Content?.Simple?.Headers).toBeUndefined();
  });
});
