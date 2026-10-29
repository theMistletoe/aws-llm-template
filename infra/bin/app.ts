import { App, Tags } from 'aws-cdk-lib';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appConfig } from '../config/app-config';
import { loadDeploySettings, type DeploySettings } from '../config/options';
import { AgentCoreStack } from '../lib/agentcore-stack';
import { ApiStack } from '../lib/api-stack';
import { AuthStack } from '../lib/auth-stack';
import { DataStack } from '../lib/data-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { MonitoringStack } from '../lib/monitoring-stack';
import { BudgetsStack } from '../optional/budgets-stack';
import { CicdStack } from '../optional/cicd-stack';
import { WafStack } from '../optional/waf-stack';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const ASSETS = {
  apiDistDir: resolve(root, 'dist/api'),
  agentZipPath: resolve(root, 'dist/agent/agent.zip'),
  webDistDir: resolve(root, 'apps/web/dist'),
};

export function buildApp(app = new App(), assets = ASSETS, settings: DeploySettings = loadDeploySettings()) {
  for (const [name, path] of Object.entries(assets)) {
    if (!existsSync(path)) throw new Error(`${name} (${path}) がありません。先に \`pnpm build\` を実行してください。`);
  }
  const config = appConfig(settings);
  const account = process.env.CDK_DEFAULT_ACCOUNT;
  const env = { account, region: settings.region };
  const appName = config.appName;
  const prefix = `ChatApp-${settings.stage}`;
  const appOriginParameterName = `/${appName}/${settings.stage}/app-origin`;

  const data = new DataStack(app, `${prefix}-Data`, { env, appName, stage: settings.stage });
  const auth = new AuthStack(app, `${prefix}-Auth`, { env, appName, settings });
  const agent = new AgentCoreStack(app, `${prefix}-AgentCore`, { env, appName, settings, config, agentZipPath: assets.agentZipPath });
  const api = new ApiStack(app, `${prefix}-Api`, {
    env,
    appName,
    settings,
    config,
    data,
    auth,
    agent,
    apiDistDir: assets.apiDistDir,
    appOriginParameterName,
  });
  const waf = settings.enableWaf
    ? new WafStack(app, `${prefix}-Waf`, { env: { account, region: 'us-east-1' }, crossRegionReferences: true, appName, stage: settings.stage })
    : undefined;
  new FrontendStack(app, `${prefix}-Frontend`, {
    env,
    appName,
    settings,
    api,
    webDistDir: assets.webDistDir,
    appOriginParameterName,
    ...(waf ? { webAclArn: waf.webAclArn, crossRegionReferences: true } : {}),
  });
  new MonitoringStack(app, `${prefix}-Monitoring`, { env, appName, settings, config, api, data, agent });
  if (settings.enableBudgets) {
    new BudgetsStack(app, `${prefix}-Budgets`, {
      env,
      appName,
      stage: settings.stage,
      monthlyUsd: settings.budgetMonthlyUsd,
      email: settings.budgetEmail!,
    });
  }
  if (settings.enableCiCd) {
    new CicdStack(app, `${prefix}-Cicd`, { env, appName, stage: settings.stage, githubRepository: settings.githubRepository! });
  }
  Tags.of(app).add('app', 'ai-chat-starter-kit');
  Tags.of(app).add('stage', settings.stage);
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildApp().synth();
}
