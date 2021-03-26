/*
 * Copyright 2020 Spotify AB
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createApiRef, DiscoveryApi } from '@backstage/core';
import { CITableBuildInfo } from '../components/BuildsPage/lib/CITable';
import fetch from 'cross-fetch';

const jenkins = require('jenkins');

export const jenkinsApiRef = createApiRef<JenkinsApi>({
  id: 'plugin.jenkins.service',
  description: 'Used by the Jenkins plugin to make requests',
});

const DEFAULT_PROXY_PATH = '/jenkins/api';

type Options = {
  discoveryApi: DiscoveryApi;
  /**
   * Path to use for requests via the proxy, defaults to /jenkins/api
   */
  proxyPath?: string;
};

export class JenkinsApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly proxyPath: string;

  constructor(options: Options) {
    this.discoveryApi = options.discoveryApi;
    this.proxyPath = options.proxyPath ?? DEFAULT_PROXY_PATH;
  }

  private async getProxyUrl() {
    const proxyUrl = await this.discoveryApi.getBaseUrl('proxy');
    return proxyUrl;
  }

  private async getClient() {
    const proxyUrl = await this.discoveryApi.getBaseUrl('proxy');
    return jenkins({ baseUrl: proxyUrl + this.proxyPath, promisify: true });
  }

  async retry(buildName: string) {
    const client = await this.getClient();
    // looks like the current SDK only supports triggering a new build
    // can't see any support for replay (re-running the specific build with the same SCM info)
    return await client.job.build(buildName);
  }

  async getLastBuild(jobName: string) {
    // const client = await this.getClient();
    // const job = await client.job.get(jobName);

    // const lastBuild = await client.build.get(jobName, job.lastBuild.number);
    return {};
  }

  extractScmDetailsFromJob(jobDetails: any): any | undefined {
    const scmInfo = jobDetails.actions
      .filter(
        (action: any) =>
          action._class === 'jenkins.scm.api.metadata.ObjectMetadataAction',
      )
      .map((action: any) => {
        return {
          url: action?.objectUrl,
          // https://javadoc.jenkins.io/plugin/scm-api/jenkins/scm/api/metadata/ObjectMetadataAction.html
          // branch name for regular builds, pull request title on pull requests
          displayName: action?.objectDisplayName,
        };
      })
      .pop();

    if (!scmInfo) {
      return undefined;
    }

    const author = jobDetails.actions
      .filter(
        (action: any) =>
          action._class ===
          'jenkins.scm.api.metadata.ContributorMetadataAction',
      )
      .map((action: any) => {
        return action.contributorDisplayName;
      })
      .pop();

    if (author) {
      scmInfo.author = author;
    }

    return scmInfo;
  }

  async getJob(jobName: string) {
    const client = await this.getClient();
    return client.job.get({
      name: jobName,
      depth: 1,
    });
  }

  async getFolder(folderName: string) {
    const tree = `jobs[
               actions[*],
               builds[
                number,
                url,
                fullDisplayName,
                building,
                result,
                actions[
                  *[
                    *[
                      *[
                        *
                      ]
                    ]
                  ]
                ]
              ]{0,1},
              jobs{0,1},
              name
            ]{0,50}
            `.replace(/\s/g, '');

    const proxyUrl = await this.getProxyUrl();
    console.log(proxyUrl + this.proxyPath);
    const resp = await fetch(
      `${proxyUrl + this.proxyPath}/job/backstage-demo/job/demo/api/json`,
      // `http://ec2-34-250-74-122.eu-west-1.compute.amazonaws.com:31010/job/backstage-demo/job/demo/api/json`,
    );

    if (!resp.ok) {
      return [];
    }

    const data = await resp.json();

    const buildData = await Promise.all(
      data.builds.map(build =>
        fetch(
          `${proxyUrl + this.proxyPath}/job/backstage-demo/job/demo/${
            build.number
          }/api/json`,
        ).then(resp => {
          if (!resp.ok) {
            return {};
          }
          return resp.json();
        }),
      ),
    );

    console.log('data', data);

    console.log('buildData', buildData);

    return data.builds.map(build => ({
      id: `build-${build.number}`,
      buildName: `backstage-demo/demo/${build.number}`,
      buildNumber: build.number,
      buildUrl: build.url,
      source: {
        branchName: 'master',
        url: 'https://github.com/sbg-hackathon-backstage/hello-world-react-app',
        displayName: 'sbg-hackathon-backstage/hello-world-react-app',
        commit: {
          hash: '36bc55ea86e292722542879ec4ef5f89745910be',
        },
      },
      status:
        buildData.find(bd => bd.number === build.number)?.result || 'running',
      onRestartClick: () => {
        console.log('building...');
        fetch(
          `${proxyUrl + this.proxyPath}/job/backstage-demo/job/demo/build/api`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
          },
        );
      },
    }));
  }

  private getTestReport(
    jenkinsResult: any,
  ): {
    total: number;
    passed: number;
    skipped: number;
    failed: number;
    testUrl: string;
  } {
    return jenkinsResult.actions
      .filter(
        (action: any) =>
          action._class === 'hudson.tasks.junit.TestResultAction',
      )
      .map((action: any) => {
        return {
          total: action.totalCount,
          passed: action.totalCount - action.failCount - action.skipCount,
          skipped: action.skipCount,
          failed: action.failCount,
          testUrl: `${jenkinsResult.url}${action.urlName}/`,
        };
      })
      .pop();
  }

  async mapJenkinsBuildToCITable(
    jenkinsResult: any,
    jobScmInfo?: any,
  ): CITableBuildInfo {
    console.log(jenkinsResult);
    const source =
      jenkinsResult.actions
        .filter(
          (action: any) =>
            action._class === 'hudson.plugins.git.util.BuildData',
        )
        .map((action: any) => {
          const [first]: any = Object.values(action.buildsByBranchName);
          const branch = first.revision.branch[0];
          return {
            branchName: branch.name,
            commit: {
              hash: branch.SHA1.substring(0, 8),
            },
          };
        })
        .pop() || {};

    if (jobScmInfo) {
      source.url = jobScmInfo?.url;
      source.displayName = jobScmInfo?.displayName;
      source.author = jobScmInfo?.author;
    }

    const path = new URL(jenkinsResult.url).pathname;
    const proxyUrl = await this.getProxyUrl();

    return {
      id: path,
      buildNumber: jenkinsResult.number,
      buildUrl: jenkinsResult.url,
      buildName: jenkinsResult.fullDisplayName,
      status: jenkinsResult.building ? 'running' : jenkinsResult.result,
      onRestartClick: () => {
        console.log('building...');
        fetch(
          `${proxyUrl + this.proxyPath}/job/backstage-demo/job/demo/build/api`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
          },
        );
      },
      source: {
        branchName: 'master',
        url: 'https://github.com/sbg-hackathon-backstage/hello-world-react-app',
        displayName: 'sbg-hackathon-backstage/hello-world-react-app',
        commit: {
          hash: '36bc55ea86e292722542879ec4ef5f89745910be',
        },
      },
    };
  }

  async getBuild(buildName: string) {
    const client = await this.getClient();
    const { jobName, buildNumber } = this.extractJobDetailsFromBuildName(
      buildName,
    );

    const proxyUrl = await this.getProxyUrl();
    const resp = await fetch(
      `${
        proxyUrl + this.proxyPath
      }/job/backstage-demo/job/demo/${buildNumber}/api/json`,
    );

    if (!resp.ok) {
      return;
    }

    return resp.json();
  }

  extractJobDetailsFromBuildName(buildName: string) {
    const trimmedBuild = buildName.replace(/\/job/g, '').replace(/\/$/, '');

    const split = trimmedBuild.split('/');
    const buildNumber = parseInt(split[split.length - 1], 10);
    const jobName = trimmedBuild.slice(
      0,
      trimmedBuild.length - buildNumber.toString(10).length - 1,
    );

    return {
      jobName,
      buildNumber,
    };
  }
}
