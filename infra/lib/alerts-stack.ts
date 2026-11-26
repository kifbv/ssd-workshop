import { Stack, type StackProps } from "aws-cdk-lib";
import { CfnAnomalyMonitor, CfnAnomalySubscription } from "aws-cdk-lib/aws-ce";
import type { Construct } from "constructs";
import {
  ALERT_EMAIL_PARAMETER,
  ALERT_EMAIL_PARAMETER_VERSION,
  COST_ANOMALY_FREQUENCY,
  COST_ANOMALY_THRESHOLD_USD,
  COST_MONITOR_NAME,
  COST_SUBSCRIPTION_NAME,
  TAG_KEY,
  TAG_VALUE,
} from "./config.js";

/**
 * Ticket 3.13: AWS Cost Anomaly Detection on the workshop's cost allocation tag, with a daily email to Franck.
 * In us-east-1 (Cost Explorer's home) and in a stack of its own: the alert address is resolved here from SSM at
 * deploy time (never in the repository or a template), and the access stack can keep sessions away from this stack's
 * events and drift results by name. Tags come from the app (`Tags.of(app)`, ResourceTags on these types).
 */
export class AlertsStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const monitor = new CfnAnomalyMonitor(this, "CostMonitor", {
      monitorName: COST_MONITOR_NAME,
      monitorType: "CUSTOM",
      // Needs the `project` cost allocation tag activated in Billing (Franck, once).
      monitorSpecification: JSON.stringify({
        Tags: { Key: TAG_KEY, Values: [TAG_VALUE], MatchOptions: ["EQUALS"] },
      }),
    });

    new CfnAnomalySubscription(this, "CostAlerts", {
      subscriptionName: COST_SUBSCRIPTION_NAME,
      monitorArnList: [monitor.ref],
      frequency: COST_ANOMALY_FREQUENCY,
      thresholdExpression: JSON.stringify({
        Dimensions: {
          Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE",
          MatchOptions: ["GREATER_THAN_OR_EQUAL"],
          Values: [String(COST_ANOMALY_THRESHOLD_USD)],
        },
      }),
      // A CloudFormation dynamic reference: the template holds only the parameter's name and version.
      subscribers: [{ type: "EMAIL", address: `{{resolve:ssm:${ALERT_EMAIL_PARAMETER}:${ALERT_EMAIL_PARAMETER_VERSION}}}` }],
    });
  }
}
