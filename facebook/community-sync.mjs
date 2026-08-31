import { assertExactCommunityJoinAuthorization } from './join-policy.mjs';

export class FacebookCommunitySyncService {
  constructor({ registry, browser } = {}) { if (!registry || !browser) throw new TypeError('registry and browser are required'); this.registry = registry; this.browser = browser; }

  async processAuthorizedJoins() {
    const results = [];
    for (const item of this.registry.listFacebookCommunityJoinPlan()) {
      if (item.community.suppressedAt) { results.push({ communityId:item.community.id,outcome:'POLICY_BLOCKED',clicked:false,reason:'suppressed' }); continue; }
      let authorization;
      try { authorization = assertExactCommunityJoinAuthorization(item); }
      catch (error) { results.push({ communityId:item.community.id,outcome:'POLICY_BLOCKED',clicked:false,reason:error.message }); continue; }
      const claim = this.registry.beginFacebookCommunityJoin({ communityId:item.community.id, authorizationActionId:authorization.actionId, authorizedUrl:authorization.canonicalUrl, authorizedAt:authorization.authorizedAt });
      if (!claim.execution) { results.push({ communityId:item.community.id,outcome:'POLICY_BLOCKED',clicked:false,reason:claim.reason }); continue; }
      let observed = await this.browser.inspectAndMaybeJoin({ authorization, allowClick:claim.canClick });
      if (!claim.canClick && observed.outcome === 'VERIFICATION_UNKNOWN' && ['JOIN_REQUESTED','NEEDS_HUMAN','JOINED_CONFIRMED','ALREADY_JOINED'].includes(item.execution?.outcome)) observed = { ...observed, outcome:item.execution.outcome, reason:`conservative_recheck:${item.execution.outcome}` };
      this.registry.recordFacebookCommunityJoinOutcome(claim.execution.id, observed);
      results.push({ communityId:item.community.id,name:item.community.name,...observed,recheck:!claim.canClick });
    }
    return { authorized: results.length, clicked: results.filter(item=>item.clicked).length, outcomes:Object.fromEntries([...new Set(results.map(item=>item.outcome))].map(outcome=>[outcome,results.filter(item=>item.outcome===outcome).length])), results };
  }
}
