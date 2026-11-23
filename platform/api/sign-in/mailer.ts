// Sends the code email through SES v2 (ticket 1.4). No Reply-To: nobody needs to reply.
import { SendEmailCommand, type SendEmailCommandOutput } from "@aws-sdk/client-sesv2";
import { CONFIGURATION_SET } from "../settings.js";
import type { CodeEmail } from "./code-email.js";
import type { CodeMailer } from "./code-request.js";

/** The one method of SESv2Client this mailer uses, so tests can stub it. */
export interface SesSender {
  send(command: SendEmailCommand): Promise<SendEmailCommandOutput>;
}

export class SesCodeMailer implements CodeMailer {
  constructor(private readonly client: SesSender) {}

  async send(to: string, email: CodeEmail): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: email.from,
        // Without it SES uses the rankly.games identity's default set (another project's), which is refused.
        ConfigurationSetName: CONFIGURATION_SET,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: email.text, Charset: "UTF-8" },
              Html: { Data: email.html, Charset: "UTF-8" },
            },
          },
        },
      }),
    );
  }
}
