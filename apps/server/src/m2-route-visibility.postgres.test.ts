import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';

const integration = process.env.POSTGRES_TEST_URL ? describe : describe.skip;

integration('M2 route summaries enforce master workshop membership (PostgreSQL)', () => {
  const pool = new Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  const app = buildApp(pool);
  const org = randomUUID(), chief = randomUUID(), master = randomUUID();
  const chiefToken = randomBytes(32).toString('base64url');
  const masterToken = randomBytes(32).toString('base64url');
  const headers = (role: 'chief'|'master') => ({
    authorization: 'Bearer ' + (role === 'chief' ? chiefToken : masterToken),
  });
  const routeCodes = {
    assembly: 'ASSEMBLY-' + randomUUID().slice(0,8),
    coating: 'COATING-' + randomUUID().slice(0,8),
    mixed: 'MIXED-' + randomUUID().slice(0,8),
    draft: 'DRAFT-' + randomUUID().slice(0,8),
  };

  beforeAll(async () => {
    const target = new URL(process.env.POSTGRES_TEST_URL!);
    if (!['localhost','127.0.0.1'].includes(target.hostname) ||
        target.pathname !== '/production_mf_ci') {
      throw new Error('Refusing any non-disposable PostgreSQL database');
    }
    expect((await pool.query('SELECT current_database() AS name')).rows[0].name)
      .toBe('production_mf_ci');
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2)',
      [org, 'M2 master route visibility fixture']);
    for (const [id,role,token] of [[chief,'chief',chiefToken],[master,'master',masterToken]] as const) {
      await pool.query(`INSERT INTO users(id,organization_id,login,password_hash,role)
        VALUES($1,$2,$3,'test-only',$4)`,[id,org,'route-visibility-'+id,role]);
      await pool.query(`INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '30 minutes')`,
        [randomUUID(),org,id,tokenHash(token)]);
    }
    await pool.query(`INSERT INTO workshops(organization_id,id,name)
      VALUES($1,'assembly','Assembly'),($1,'coating','Coating')`,[org]);
    await pool.query(`INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id)
      VALUES($1,$2,'assembly')`,[org,master]);
    for (const [name,workshops] of Object.entries({
      assembly:['assembly'], coating:['coating'],
      mixed:['assembly','coating'], draft:['assembly'],
    })) {
      const created = await app.inject({
        method:'POST',url:'/planning/routes',headers:headers('chief'),
        payload:{
          code:routeCodes[name as keyof typeof routeCodes],name:'Route '+name,
          steps:workshops.map((workshopId,index)=>({
            name:'Step '+(index+1),stage:workshopId,workshopId,electrodeLine:'common',
          })),
        },
      });
      expect(created.statusCode).toBe(201);
      if (name !== 'draft') {
        const approved = await app.inject({method:'POST',
          url:'/planning/routes/'+created.json().id+'/versions/1/approve',headers:headers('chief')});
        expect(approved.statusCode).toBe(200);
      }
    }
  });

  afterAll(async () => {
    // Immutable approved route versions stay in this isolated CI database
    // until the runner destroys it. No production database is reachable.
    await app.close();
    await pool.end();
  });

  const visible = async () => {
    const response = await app.inject({method:'GET',url:'/planning/routes',headers:headers('master')});
    expect(response.statusCode).toBe(200);
    return response.json().routes.map((row:{code:string})=>row.code).sort();
  };

  it('hides unapproved and other-workshop routes from masters without full membership', async () => {
    expect(await visible()).toEqual([routeCodes.assembly]);
    const directory = await app.inject({
      method:'GET',url:'/planning/workshops',headers:headers('master'),
    });
    expect(directory.statusCode).toBe(200);
    expect(directory.json().workshops).toEqual([{id:'assembly',name:'Assembly'}]);
    const chiefList = await app.inject({method:'GET',url:'/planning/routes',headers:headers('chief')});
    expect(chiefList.json().routes).toHaveLength(4);
  });

  it('refreshes master route access when memberships are granted or revoked', async () => {
    await pool.query(`INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id)
      VALUES($1,$2,'coating')`,[org,master]);
    expect(await visible()).toEqual([
      routeCodes.assembly,routeCodes.coating,routeCodes.mixed,
    ].sort());
    await pool.query(`DELETE FROM user_workshop_memberships
      WHERE organization_id=$1 AND user_id=$2 AND workshop_id='assembly'`,[org,master]);
    expect(await visible()).toEqual([routeCodes.coating]);
    await pool.query(`DELETE FROM user_workshop_memberships
      WHERE organization_id=$1 AND user_id=$2 AND workshop_id='coating'`,[org,master]);
    expect(await visible()).toEqual([]);
  });
});
