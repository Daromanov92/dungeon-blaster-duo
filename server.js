const http=require('http');
const fs=require('fs');
const path=require('path');
const WebSocket=require('ws');

const PORT=process.env.PORT||8080;
const LOBBY={w:960,h:540,door:{x:865,y:190,w:55,h:160}};
const DUNGEON={w:4800,h:2700};
const SIM_HZ=60;
const SIM_DT=1/SIM_HZ;
const SNAPSHOT_MS=50; // 20 Hz: authoritative state, visuals run locally at render FPS
const SNAPSHOT_BACKPRESSURE=128*1024;

const SKINS=['mech_01.png','mech_02.png','mech_03.png','mech_04.png','mech_05.png','mech_06.png','mech_07.png','mech_08.png','mech_09.png','mech_10.png'];
const ALLOWED_SKINS=new Set(SKINS);
const WEAPONS={
  auto:{name:'Автомат',mag:30,fireCd:.075,reload:1.15,speed:4500,dmg:7,life:.55},
  rail:{name:'Рельсотрон',mag:5,fireCd:1,reload:1.8,dmg:90,range:1800},
  shotgun:{name:'Дробовик',mag:8,fireCd:.62,reload:1.3,speed:1100,dmg:9,life:.72,pellets:7,spread:.18},
  grenade:{name:'Гранатомёт',mag:4,fireCd:.9,reload:1.55,speed:650,dmg:78,life:1.15,radius:115}
};
const WEAPON_IDS=['auto','rail','shotgun','grenade'];
const ALLOWED_WEAPONS=new Set(WEAPON_IDS);

let nextPlayerId=1,nextEnemyId=1,nextBulletId=1,nextShotId=1;
const players=new Map();
const dungeon={
  wave:1,enemies:new Map(),bullets:[],pickups:[],
  checkpoint:false,checkpointDoor:{x:2360,y:1260,w:80,h:180}
};

const server=http.createServer((req,res)=>{
  let u=(req.url||'/').split('?')[0];
  if(u==='/')u='/index.html';
  let decoded;
  try{decoded=decodeURIComponent(u);}catch{res.writeHead(400);res.end('Bad request');return;}
  const publicDir=path.resolve(__dirname,'public');
  const file=path.resolve(publicDir,'.'+decoded);
  if(!file.startsWith(publicDir+path.sep)){res.writeHead(403);res.end('Forbidden');return;}
  fs.readFile(file,(err,data)=>{
    if(err){res.writeHead(404);res.end('Not found');return;}
    const ext=path.extname(file).toLowerCase();
    const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'};
    res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':ext==='.html'?'no-cache':'public, max-age=3600'});
    res.end(data);
  });
});

const wss=new WebSocket.Server({server,perMessageDeflate:false,maxPayload:32*1024});
const zonePlayers=zone=>[...players.values()].filter(p=>p.zone===zone);
const send=(ws,obj)=>{
  if(ws.readyState!==WebSocket.OPEN)return false;
  ws.send(JSON.stringify(obj));return true;
};
const broadcast=(zone,obj)=>{
  const msg=JSON.stringify(obj);
  for(const p of players.values())if(p.zone===zone&&p.ws.readyState===WebSocket.OPEN&&p.ws.bufferedAmount<256*1024)p.ws.send(msg);
};

function cleanProfile(raw){
  const r=raw&&typeof raw==='object'?raw:{};
  return {
    level:Math.max(1,Math.min(999,Number(r.level)||1)),
    xp:Math.max(0,Number(r.xp)||0),
    kills:Math.max(0,Number(r.kills)||0),
    coins:Math.max(0,Number(r.coins)||0),
    bestWave:Math.max(1,Number(r.bestWave)||1),
    skin:ALLOWED_SKINS.has(String(r.skin||''))?String(r.skin):'mech_01.png',
    weapon:ALLOWED_WEAPONS.has(String(r.weapon||''))?String(r.weapon):'auto'
  };
}
const threshold=level=>100+Math.max(0,level-1)*75;
function levelProfile(p){
  while(p.profile.xp>=threshold(p.profile.level)){
    p.profile.xp-=threshold(p.profile.level);
    p.profile.level++;
  }
  p.profileDirty=true;
}
function awardKill(p){
  p.profile.kills++;p.profile.coins+=2;p.profile.xp+=20;levelProfile(p);
}
function awardWave(p,wave){
  p.profile.bestWave=Math.max(p.profile.bestWave,wave);p.profile.xp+=10;levelProfile(p);
}
function weaponOf(p){return WEAPONS[p.profile.weapon]||WEAPONS.auto;}
function resetMotion(p){
  p.input={dx:0,dy:0};
  p.vx=0;p.vy=0;p.dashCd=0;p.dashTime=0;p.dashHeld=false;
  p.fireCd=0;p.reload=0;
}
function resetLobby(p){
  const n=p.id%12;
  p.zone='lobby';p.x=120+(n%6)*42;p.y=205+Math.floor(n/6)*58;
  p.hp=100;p.alive=true;p.ammo=weaponOf(p).mag;p.atCheckpointPrompt=false;
  resetMotion(p);
}
function resetDungeon(p){
  p.zone='dungeon';p.x=420+(p.id%6)*42;p.y=DUNGEON.h/2+((p.id%5)-2)*46;
  p.hp=100;p.alive=true;p.ammo=weaponOf(p).mag;p.atCheckpointPrompt=false;
  resetMotion(p);
}
function spawnWave(){
  dungeon.enemies.clear();dungeon.bullets=[];dungeon.pickups=[];
  const count=Math.min(70,18+dungeon.wave*4);
  for(let i=0;i<count;i++){
    let x,y;
    do{
      x=500+Math.random()*(DUNGEON.w-650);
      y=120+Math.random()*(DUNGEON.h-240);
    }while(x<950&&Math.abs(y-DUNGEON.h/2)<420);
    const hp=30+dungeon.wave*6;
    dungeon.enemies.set(nextEnemyId,{
      id:nextEnemyId++,x,y,vx:0,vy:0,hp,maxHp:hp,
      speed:52+dungeon.wave*1.6,
      type:Math.random()<.32?'shooter':'melee',
      shoot:.7+Math.random()*1.3
    });
  }
}
spawnWave();

function nearestAlive(e){
  let target=null,best=Infinity;
  for(const p of players.values()){
    if(p.zone!=='dungeon'||!p.alive)continue;
    const d=Math.hypot(p.x-e.x,p.y-e.y);
    if(d<best){best=d;target=p;}
  }
  return [target,best];
}
function damage(p,d){
  if(!p.alive)return;
  p.hp-=d;
  if(p.hp<=0){p.hp=0;p.alive=false;p.vx=0;p.vy=0;}
}
function insideDoor(p){
  const d=LOBBY.door;
  return p.x>d.x-10&&p.x<d.x+d.w+10&&p.y>d.y-10&&p.y<d.y+d.h+10;
}
function insideCheckpointDoor(p){
  if(!dungeon.checkpoint)return false;
  const d=dungeon.checkpointDoor;
  return p.x>d.x-12&&p.x<d.x+d.w+12&&p.y>d.y-12&&p.y<d.y+d.h+12;
}
function skinCode(s){const i=SKINS.indexOf(s);return i<0?0:i;}
function weaponCode(w){const i=WEAPON_IDS.indexOf(w);return i<0?0:i;}
function playerPacket(p){
  return [
    p.id,p.nick,
    Math.round(p.x*10)/10,Math.round(p.y*10)/10,
    Math.round(p.hp*10)/10,p.alive?1:0,p.ammo,Math.max(0,Math.round(p.reload*100)/100),
    p.profile.level,skinCode(p.profile.skin),weaponCode(p.profile.weapon),weaponOf(p).mag,
    (Math.abs(p.vx)+Math.abs(p.vy)>1)?1:0,p.facing||1,
    Math.round(p.vx*10)/10,Math.round(p.vy*10)/10
  ];
}
function enemyPacket(e){
  return [e.id,Math.round(e.x*10)/10,Math.round(e.y*10)/10,Math.round(e.hp*10)/10,e.maxHp,e.type==='shooter'?1:0,Math.round(e.vx*10)/10,Math.round(e.vy*10)/10];
}
function buildLobbySnapshot(st){
  return JSON.stringify({t:'s',z:0,st,p:zonePlayers('lobby').map(playerPacket),v:dungeon.wave});
}
function buildDungeonSnapshot(st){
  return JSON.stringify({
    t:'s',z:1,st,
    p:zonePlayers('dungeon').map(playerPacket),
    e:[...dungeon.enemies.values()].map(enemyPacket),
    b:dungeon.bullets.filter(b=>b.team==='e').map(b=>[b.id,Math.round(b.x*10)/10,Math.round(b.y*10)/10,Math.round(b.vx*10)/10,Math.round(b.vy*10)/10]),
    k:dungeon.pickups.map(pk=>[Math.round(pk.x*10)/10,Math.round(pk.y*10)/10,pk.type==='heal'?1:0]),
    v:dungeon.wave,c:dungeon.checkpoint?1:0
  });
}

function segmentDist(px,py,x1,y1,x2,y2){
  const vx=x2-x1,vy=y2-y1,wx=px-x1,wy=py-y1,c=vx*vx+vy*vy;
  if(c<=.0001)return Math.hypot(px-x1,py-y1);
  const t=Math.max(0,Math.min(1,(wx*vx+wy*vy)/c));
  return Math.hypot(px-(x1+vx*t),py-(y1+vy*t));
}
function killEnemy(e,ownerId){
  if(!dungeon.enemies.has(e.id))return;
  dungeon.enemies.delete(e.id);
  const owner=players.get(ownerId);if(owner)awardKill(owner);
  if(Math.random()<.38)dungeon.pickups.push({x:e.x,y:e.y,type:Math.random()<.55?'ammo':'heal'});
}
function explodeGrenade(b){
  if(b.exploded)return;b.exploded=true;
  const radius=b.radius||115;
  for(const e of [...dungeon.enemies.values()]){
    const d=Math.hypot(b.x-e.x,b.y-e.y);if(d>radius)continue;
    e.hp-=b.dmg*(1-.55*d/radius);
    if(e.hp<=0)killEnemy(e,b.owner);
  }
  broadcast('dungeon',{type:'explosion_fx',x:b.x,y:b.y,radius,shotId:b.shotId});
}

wss.on('connection',ws=>{
  ws._alive=true;
  ws.on('pong',()=>ws._alive=true);
  let p=null;

  ws.on('message',buf=>{
    let m;try{m=JSON.parse(buf.toString())}catch{return;}

    if(m.type==='ping'){
      send(ws,{type:'pong',clientTime:Number(m.clientTime)||0,serverTime:Date.now()});
      return;
    }

    if(m.type==='join'){
      if(p)return;
      const nick=String(m.nick||'Player').trim().slice(0,16)||'Player';
      const profile=cleanProfile(m.profile);
      p={
        id:nextPlayerId++,nick,ws,profile,profileDirty:false,
        zone:'lobby',x:150,y:270,vx:0,vy:0,hp:100,alive:true,
        ammo:WEAPONS[profile.weapon].mag,reload:0,fireCd:0,
        dashCd:0,dashTime:0,dashHeld:false,input:{dx:0,dy:0},
        facing:1,atCheckpointPrompt:false
      };
      resetLobby(p);players.set(p.id,p);
      send(ws,{type:'joined',id:p.id,profile:p.profile,serverTime:Date.now()});
      return;
    }
    if(!p)return;

    if(m.type==='set_skin'){
      const skin=String(m.skin||'');
      if(ALLOWED_SKINS.has(skin)){
        p.profile.skin=skin;p.profileDirty=true;
        send(ws,{type:'skin_applied',id:p.id,skin});
        broadcast(p.zone,{type:'skin_changed',id:p.id,skin});
      }else send(ws,{type:'skin_error'});
      return;
    }

    if(m.type==='set_weapon'){
      const weapon=String(m.weapon||'');
      if(p.zone==='lobby'&&ALLOWED_WEAPONS.has(weapon)){
        p.profile.weapon=weapon;p.profileDirty=true;
        p.ammo=WEAPONS[weapon].mag;p.reload=0;p.fireCd=0;
        send(ws,{type:'weapon_applied',id:p.id,weapon,mag:WEAPONS[weapon].mag});
        broadcast('lobby',{type:'weapon_changed',id:p.id,weapon});
      }
      return;
    }

    if(m.type==='input'&&p.alive){
      let dx=Number(m.dx)||0,dy=Number(m.dy)||0;
      const len=Math.hypot(dx,dy);if(len>1){dx/=len;dy/=len;}
      p.input.dx=dx;p.input.dy=dy;
      const dash=!!m.dash;
      if(dash&&!p.dashHeld&&p.dashCd<=0){p.dashTime=.12;p.dashCd=1.05;}
      p.dashHeld=dash;
      if(m.facing===-1||m.facing===1)p.facing=m.facing;
      return;
    }

    if(m.type==='shoot'&&p.zone==='dungeon'&&p.alive&&p.fireCd<=0&&p.reload<=0){
      const w=weaponOf(p);
      if(p.ammo<=0){p.reload=w.reload;return;}
      let dx=Number(m.dx)||0,dy=Number(m.dy)||0;
      const len=Math.hypot(dx,dy)||1;dx/=len;dy/=len;
      p.ammo--;p.fireCd=w.fireCd;
      const shotId=nextShotId++;
      broadcast('dungeon',{type:'fire_fx',owner:p.id,weapon:p.profile.weapon,x:p.x,y:p.y,dx,dy,shotId});

      if(p.profile.weapon==='rail'){
        const x2=p.x+dx*w.range,y2=p.y+dy*w.range;
        for(const e of [...dungeon.enemies.values()]){
          if(segmentDist(e.x,e.y,p.x,p.y,x2,y2)<=22){
            e.hp-=w.dmg;if(e.hp<=0)killEnemy(e,p.id);
          }
        }
      }else if(p.profile.weapon==='shotgun'){
        const base=Math.atan2(dy,dx);
        for(let i=0;i<w.pellets;i++){
          const a=base+(i-(w.pellets-1)/2)*(w.spread/(w.pellets-1))*2;
          dungeon.bullets.push({id:nextBulletId++,x:p.x,y:p.y,vx:Math.cos(a)*w.speed,vy:Math.sin(a)*w.speed,life:w.life,team:'p',owner:p.id,dmg:w.dmg,kind:'shotgun',shotId});
        }
      }else{
        dungeon.bullets.push({id:nextBulletId++,x:p.x,y:p.y,vx:dx*w.speed,vy:dy*w.speed,life:w.life,team:'p',owner:p.id,dmg:w.dmg,kind:p.profile.weapon,radius:w.radius||0,shotId});
      }
      return;
    }

    if(m.type==='reload'&&p.zone==='dungeon'&&p.reload<=0){
      const w=weaponOf(p);if(p.ammo<w.mag)p.reload=w.reload;
      return;
    }
    if(m.type==='respawn'&&p.zone==='dungeon'&&!p.alive){
      p.hp=60;p.alive=true;p.x=420;p.y=DUNGEON.h/2;p.ammo=weaponOf(p).mag;resetMotion(p);
      return;
    }
    if(m.type==='return_lobby'){resetLobby(p);return;}

    if(m.type==='checkpoint_action'){
      if(m.action==='hub'){
        p.atCheckpointPrompt=false;resetLobby(p);send(ws,{type:'back_to_hub'});
      }else if(m.action==='continue'&&dungeon.checkpoint){
        dungeon.checkpoint=false;dungeon.wave++;
        for(const q of zonePlayers('dungeon')){
          q.atCheckpointPrompt=false;q.hp=Math.min(100,q.hp+20);
          send(q.ws,{type:'checkpoint_closed'});send(q.ws,{type:'wave',wave:dungeon.wave});
        }
        spawnWave();
      }
    }
  });

  ws.on('close',()=>{if(p)players.delete(p.id);});
  ws.on('error',()=>{});
});

setInterval(()=>{
  for(const p of players.values()){
    p.fireCd=Math.max(0,p.fireCd-SIM_DT);
    p.dashCd=Math.max(0,p.dashCd-SIM_DT);
    p.dashTime=Math.max(0,p.dashTime-SIM_DT);
    if(p.reload>0){p.reload-=SIM_DT;if(p.reload<=0)p.ammo=weaponOf(p).mag;}
    if(!p.alive){p.vx=0;p.vy=0;continue;}

    const world=p.zone==='lobby'?LOBBY:DUNGEON;
    const speed=p.dashTime>0?(p.zone==='lobby'?330:460):(p.zone==='lobby'?180:205);
    p.vx=p.input.dx*speed;p.vy=p.input.dy*speed;
    p.x=Math.max(32,Math.min(world.w-32,p.x+p.vx*SIM_DT));
    p.y=Math.max(32,Math.min(world.h-32,p.y+p.vy*SIM_DT));

    if(p.zone==='lobby'&&insideDoor(p)){
      resetDungeon(p);send(p.ws,{type:'entered_dungeon',wave:dungeon.wave});
    }
    if(p.zone==='dungeon'&&dungeon.checkpoint){
      if(insideCheckpointDoor(p)&&!p.atCheckpointPrompt){
        p.atCheckpointPrompt=true;p.input.dx=0;p.input.dy=0;p.vx=0;p.vy=0;
        send(p.ws,{type:'checkpoint_choice',wave:dungeon.wave});
      }else if(!insideCheckpointDoor(p)&&p.atCheckpointPrompt)p.atCheckpointPrompt=false;
    }
  }

  const active=zonePlayers('dungeon');
  if(active.length===0)return;

  for(const e of dungeon.enemies.values()){
    const [t,d]=nearestAlive(e);
    if(!t){e.vx=0;e.vy=0;continue;}
    const dx=t.x-e.x,dy=t.y-e.y,len=Math.hypot(dx,dy)||1,nx=dx/len,ny=dy/len;
    e.vx=0;e.vy=0;
    if(e.type==='melee'){
      if(d>26){e.vx=nx*e.speed;e.vy=ny*e.speed;}
      else damage(t,17*SIM_DT);
    }else{
      if(d>260){e.vx=nx*e.speed*.70;e.vy=ny*e.speed*.70;}
      else if(d<180){e.vx=-nx*e.speed*.55;e.vy=-ny*e.speed*.55;}
      e.shoot-=SIM_DT;
      if(e.shoot<=0&&d<620){
        dungeon.bullets.push({id:nextBulletId++,x:e.x,y:e.y,vx:nx*340,vy:ny*340,life:3,team:'e',owner:e.id,dmg:10,kind:'enemy'});
        e.shoot=.9+Math.random()*1.1;
      }
    }
    e.x+=e.vx*SIM_DT;e.y+=e.vy*SIM_DT;
  }

  for(const b of dungeon.bullets){
    const ox=b.x,oy=b.y;
    b.x+=b.vx*SIM_DT;b.y+=b.vy*SIM_DT;b.life-=SIM_DT;
    if(b.x<20||b.x>DUNGEON.w-20||b.y<20||b.y>DUNGEON.h-20)b.life=0;

    if(b.team==='p'){
      if(b.kind==='grenade'){
        let hit=false;
        for(const e of dungeon.enemies.values())if(segmentDist(e.x,e.y,ox,oy,b.x,b.y)<22){hit=true;break;}
        if(hit||b.life<=0){explodeGrenade(b);b.life=0;}
      }else{
        for(const e of dungeon.enemies.values()){
          if(segmentDist(e.x,e.y,ox,oy,b.x,b.y)<20){
            e.hp-=b.dmg;b.life=0;if(e.hp<=0)killEnemy(e,b.owner);break;
          }
        }
      }
    }else{
      for(const p of active){
        if(p.alive&&segmentDist(p.x,p.y,ox,oy,b.x,b.y)<20){damage(p,b.dmg);b.life=0;break;}
      }
    }
  }
  dungeon.bullets=dungeon.bullets.filter(b=>b.life>0);

  for(let i=dungeon.pickups.length-1;i>=0;i--){
    const pk=dungeon.pickups[i];let taken=false;
    for(const p of active){
      if(p.alive&&Math.hypot(pk.x-p.x,pk.y-p.y)<24){
        if(pk.type==='heal')p.hp=Math.min(100,p.hp+25);
        else p.ammo=Math.min(weaponOf(p).mag,p.ammo+Math.max(2,Math.ceil(weaponOf(p).mag*.3)));
        taken=true;break;
      }
    }
    if(taken)dungeon.pickups.splice(i,1);
  }

  if(dungeon.enemies.size===0&&!dungeon.checkpoint){
    const cleared=dungeon.wave;
    for(const p of active){if(p.alive)p.hp=Math.min(100,p.hp+15);awardWave(p,cleared);}
    if(cleared%3===0){
      dungeon.checkpoint=true;dungeon.bullets=[];dungeon.pickups=[];
      for(const p of active)send(p.ws,{type:'checkpoint_ready',wave:cleared});
    }else{
      dungeon.wave++;spawnWave();
      for(const p of active)send(p.ws,{type:'wave',wave:dungeon.wave});
    }
  }
},1000*SIM_DT);

// Profile traffic is intentionally batched: kill streaks no longer create a burst of JSON messages.
setInterval(()=>{
  for(const p of players.values()){
    if(!p.profileDirty)continue;
    p.profileDirty=false;send(p.ws,{type:'profile_update',profile:p.profile});
  }
},250);

// Build each zone snapshot exactly once, then reuse the serialized payload for every socket.
setInterval(()=>{
  const st=Date.now();
  const lobby=zonePlayers('lobby');
  if(lobby.length){
    const msg=buildLobbySnapshot(st);
    for(const p of lobby)if(p.ws.readyState===WebSocket.OPEN&&p.ws.bufferedAmount<SNAPSHOT_BACKPRESSURE)p.ws.send(msg);
  }
  const active=zonePlayers('dungeon');
  if(active.length){
    const msg=buildDungeonSnapshot(st);
    for(const p of active)if(p.ws.readyState===WebSocket.OPEN&&p.ws.bufferedAmount<SNAPSHOT_BACKPRESSURE)p.ws.send(msg);
  }
},SNAPSHOT_MS);

// Detect dead TCP/WebSocket sessions without application-level traffic.
setInterval(()=>{
  for(const ws of wss.clients){
    if(ws._alive===false){ws.terminate();continue;}
    ws._alive=false;try{ws.ping();}catch{}
  }
},15000);

server.listen(PORT,'0.0.0.0',()=>console.log('Dungeon Blaster netcode v2 running on port '+PORT));
