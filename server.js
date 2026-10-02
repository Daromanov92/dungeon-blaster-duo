const http=require('http');
const fs=require('fs');
const path=require('path');
const WebSocket=require('ws');

const PORT=process.env.PORT||8080;
const VIEW_W=960,VIEW_H=540;
const LOBBY={w:960,h:540,door:{x:865,y:190,w:55,h:160}};
const DUNGEON={w:4800,h:2700};
const SIM_DT=1/60,SNAPSHOT_MS=33;

let nextPlayerId=1,nextEnemyId=1;
const players=new Map();
const dungeon={wave:1,enemies:new Map(),bullets:[],pickups:[],checkpoint:false,checkpointDoor:{x:2360,y:1260,w:80,h:180}};

const server=http.createServer((req,res)=>{
  let u=req.url.split('?')[0];
  if(u==='/')u='/index.html';
  const f=path.join(__dirname,'public',u);
  fs.readFile(f,(err,data)=>{
    if(err){res.writeHead(404);res.end('Not found');return;}
    const ext=path.extname(f);
    const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
    res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-cache'});
    res.end(data);
  });
});

const wss=new WebSocket.Server({server,perMessageDeflate:false});
const send=(ws,o)=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(o));};
const zonePlayers=zone=>[...players.values()].filter(p=>p.zone===zone);
const broadcastZone=(zone,o)=>{const msg=JSON.stringify(o);for(const q of zonePlayers(zone))if(q.ws.readyState===WebSocket.OPEN)q.ws.send(msg);};
const ALLOWED_SKINS=new Set(['mech_01.png','mech_02.png','mech_03.png','mech_04.png','mech_05.png','mech_06.png','mech_07.png','mech_08.png','mech_09.png','mech_10.png']);

function cleanProfile(raw){
  const r=raw&&typeof raw==='object'?raw:{};
  return {
    level:Math.max(1,Math.min(999,Number(r.level)||1)),
    xp:Math.max(0,Number(r.xp)||0),
    kills:Math.max(0,Number(r.kills)||0),
    coins:Math.max(0,Number(r.coins)||0),
    bestWave:Math.max(1,Number(r.bestWave)||1),
    skin:ALLOWED_SKINS.has(String(r.skin||''))?String(r.skin):'mech_01.png'
  };
}
function profileThreshold(level){return 100+Math.max(0,level-1)*75;}
function awardKill(p){
  p.profile.kills++;
  p.profile.coins+=2;
  p.profile.xp+=20;
  while(p.profile.xp>=profileThreshold(p.profile.level)){
    p.profile.xp-=profileThreshold(p.profile.level);
    p.profile.level++;
  }
  send(p.ws,{type:'profile_update',profile:p.profile});
}
function awardWave(p,wave){
  p.profile.bestWave=Math.max(p.profile.bestWave,wave);
  p.profile.xp+=10;
  while(p.profile.xp>=profileThreshold(p.profile.level)){
    p.profile.xp-=profileThreshold(p.profile.level);
    p.profile.level++;
  }
  send(p.ws,{type:'profile_update',profile:p.profile});
}
function resetLobby(p){
  const n=(p.id%8);
  p.zone='lobby';
  p.x=135+(n%4)*46;
  p.y=220+Math.floor(n/4)*54;
  p.hp=100;p.alive=true;p.ammo=8;p.reload=0;p.fireCd=0;p.dashCd=0;
  p.input={dx:0,dy:0,dash:false};
  p.atCheckpointPrompt=false;
}
function resetDungeon(p){
  p.zone='dungeon';
  p.x=420+(p.id%6)*42;
  p.y=DUNGEON.h/2+((p.id%5)-2)*46;
  p.hp=100;p.alive=true;p.ammo=8;p.reload=0;p.fireCd=0;p.dashCd=0;
  p.input={dx:0,dy:0,dash:false};
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
      id:nextEnemyId++,x,y,hp,maxHp:hp,
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
  if(p.hp<=0){p.hp=0;p.alive=false;}
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
function playerView(p){
  return {id:p.id,nick:p.nick,x:p.x,y:p.y,hp:p.hp,alive:p.alive,ammo:p.ammo,reload:p.reload,level:p.profile.level,skin:p.profile.skin,moving:Math.abs(p.input.dx)>0.01||Math.abs(p.input.dy)>0.01,facing:p.facing||1};
}
function snapshotFor(p){
  if(p.zone==='lobby'){
    return {
      type:'snapshot',zone:'lobby',world:{w:LOBBY.w,h:LOBBY.h},door:LOBBY.door,
      players:zonePlayers('lobby').map(playerView),
      enemies:[],bullets:[],pickups:[],wave:dungeon.wave
    };
  }
  return {
    type:'snapshot',zone:'dungeon',world:{w:DUNGEON.w,h:DUNGEON.h},
    players:zonePlayers('dungeon').map(playerView),
    enemies:[...dungeon.enemies.values()].map(e=>({id:e.id,x:e.x,y:e.y,hp:e.hp,maxHp:e.maxHp,type:e.type})),
    bullets:dungeon.bullets.map(b=>({x:b.x,y:b.y,vx:b.vx,vy:b.vy,team:b.team})),
    pickups:dungeon.pickups,wave:dungeon.wave,
    checkpoint:dungeon.checkpoint,checkpointDoor:dungeon.checkpoint?dungeon.checkpointDoor:null
  };
}

wss.on('connection',ws=>{
  let p=null;
  ws.on('message',buf=>{
    let m;try{m=JSON.parse(buf.toString())}catch{return;}

    if(m.type==='join'){
      if(p)return;
      const nick=String(m.nick||'Player').trim().slice(0,16)||'Player';
      p={
        id:nextPlayerId++,nick,ws,
        profile:cleanProfile(m.profile),
        zone:'lobby',x:150,y:270,hp:100,alive:true,ammo:8,reload:0,fireCd:0,dashCd:0,
        input:{dx:0,dy:0,dash:false},facing:1,atCheckpointPrompt:false
      };
      resetLobby(p);
      players.set(p.id,p);
      send(ws,{type:'joined',id:p.id,profile:p.profile});
      return;
    }
    if(!p)return;

    if(m.type==='set_skin'){
      const skin=String(m.skin||'');
      if(ALLOWED_SKINS.has(skin)){
        p.profile.skin=skin;
        send(p.ws,{type:'profile_update',profile:p.profile});
        send(p.ws,{type:'skin_applied',id:p.id,skin});
        broadcastZone(p.zone,{type:'skin_changed',id:p.id,skin});
      }else{
        send(p.ws,{type:'skin_error',skin});
      }
      return;
    }

    if(m.type==='input'&&p.alive){
      let dx=Number(m.dx)||0,dy=Number(m.dy)||0;
      const l=Math.hypot(dx,dy);
      if(l>1){dx/=l;dy/=l;}
      p.input={dx,dy,dash:!!m.dash};
      if(m.facing===-1||m.facing===1)p.facing=m.facing;
      return;
    }
    if(m.type==='shoot'&&p.zone==='dungeon'&&p.alive&&p.fireCd<=0&&p.reload<=0){
      if(p.ammo<=0){p.reload=.72;return;}
      let dx=Number(m.dx)||0,dy=Number(m.dy)||0;
      const l=Math.hypot(dx,dy)||1;dx/=l;dy/=l;
      p.ammo--;p.fireCd=.15;
      dungeon.bullets.push({x:p.x,y:p.y,vx:dx*900,vy:dy*900,life:1.5,team:'p',owner:p.id,dmg:15});
      return;
    }
    if(m.type==='reload'&&p.zone==='dungeon'&&p.reload<=0&&p.ammo<8)p.reload=.72;
    if(m.type==='respawn'&&p.zone==='dungeon'&&!p.alive){p.hp=60;p.alive=true;p.x=420;p.y=DUNGEON.h/2;}
    if(m.type==='return_lobby')resetLobby(p);
    if(m.type==='checkpoint_action'){
      if(m.action==='hub'){
        p.atCheckpointPrompt=false;
        resetLobby(p);
        send(p.ws,{type:'back_to_hub'});
      }else if(m.action==='continue'&&dungeon.checkpoint){
        dungeon.checkpoint=false;
        dungeon.wave++;
        for(const q of zonePlayers('dungeon')){
          q.atCheckpointPrompt=false;
          q.hp=Math.min(100,q.hp+20);
          send(q.ws,{type:'checkpoint_closed'});
          send(q.ws,{type:'wave',wave:dungeon.wave});
        }
        spawnWave();
      }
    }
  });

  ws.on('close',()=>{if(p)players.delete(p.id);});
});

setInterval(()=>{
  for(const p of players.values()){
    p.fireCd=Math.max(0,p.fireCd-SIM_DT);
    p.dashCd=Math.max(0,p.dashCd-SIM_DT);
    if(p.reload>0){p.reload-=SIM_DT;if(p.reload<=0)p.ammo=8;}
    if(!p.alive)continue;

    const world=p.zone==='lobby'?LOBBY:DUNGEON;
    let speed=p.zone==='lobby'?180:205;
    if(p.input.dash&&p.dashCd<=0){speed=p.zone==='lobby'?330:460;p.dashCd=1.05;}
    p.x=Math.max(32,Math.min(world.w-32,p.x+p.input.dx*speed*SIM_DT));
    p.y=Math.max(32,Math.min(world.h-32,p.y+p.input.dy*speed*SIM_DT));

    if(p.zone==='lobby'&&insideDoor(p)){
      resetDungeon(p);
      send(p.ws,{type:'entered_dungeon',wave:dungeon.wave});
    }
    if(p.zone==='dungeon'&&dungeon.checkpoint){
      if(insideCheckpointDoor(p)&&!p.atCheckpointPrompt){
        p.atCheckpointPrompt=true;
        p.input={dx:0,dy:0,dash:false};
        send(p.ws,{type:'checkpoint_choice',wave:dungeon.wave});
      }else if(!insideCheckpointDoor(p)&&p.atCheckpointPrompt){
        p.atCheckpointPrompt=false;
      }
    }
  }

  const active=zonePlayers('dungeon');
  if(active.length===0)return;

  for(const e of dungeon.enemies.values()){
    const [t,d]=nearestAlive(e);if(!t)continue;
    const dx=t.x-e.x,dy=t.y-e.y,l=Math.hypot(dx,dy)||1,nx=dx/l,ny=dy/l;
    if(e.type==='melee'){
      if(d>26){e.x+=nx*e.speed*SIM_DT;e.y+=ny*e.speed*SIM_DT;}
      else damage(t,17*SIM_DT);
    }else{
      if(d>260){e.x+=nx*e.speed*.70*SIM_DT;e.y+=ny*e.speed*.70*SIM_DT;}
      if(d<180){e.x-=nx*e.speed*.55*SIM_DT;e.y-=ny*e.speed*.55*SIM_DT;}
      e.shoot-=SIM_DT;
      if(e.shoot<=0&&d<620){
        dungeon.bullets.push({x:e.x,y:e.y,vx:nx*340,vy:ny*340,life:3,team:'e',owner:e.id,dmg:10});
        e.shoot=.9+Math.random()*1.1;
      }
    }
  }

  for(const b of dungeon.bullets){
    b.x+=b.vx*SIM_DT;b.y+=b.vy*SIM_DT;b.life-=SIM_DT;
    if(b.x<20||b.x>DUNGEON.w-20||b.y<20||b.y>DUNGEON.h-20)b.life=0;
    if(b.team==='p'){
      for(const e of dungeon.enemies.values()){
        if(Math.hypot(b.x-e.x,b.y-e.y)<16){
          e.hp-=b.dmg;b.life=0;
          if(e.hp<=0){
            dungeon.enemies.delete(e.id);
            const owner=players.get(b.owner);
            if(owner)awardKill(owner);
            if(Math.random()<.38)dungeon.pickups.push({x:e.x,y:e.y,type:Math.random()<.55?'ammo':'heal'});
          }
          break;
        }
      }
    }else{
      for(const p of active){
        if(p.alive&&Math.hypot(b.x-p.x,b.y-p.y)<16){damage(p,b.dmg);b.life=0;break;}
      }
    }
  }
  dungeon.bullets=dungeon.bullets.filter(b=>b.life>0);

  for(let i=dungeon.pickups.length-1;i>=0;i--){
    const pk=dungeon.pickups[i];let taken=false;
    for(const p of active){
      if(p.alive&&Math.hypot(pk.x-p.x,pk.y-p.y)<24){
        if(pk.type==='heal')p.hp=Math.min(100,p.hp+25);else p.ammo=Math.min(8,p.ammo+3);
        taken=true;break;
      }
    }
    if(taken)dungeon.pickups.splice(i,1);
  }

  if(dungeon.enemies.size===0&&!dungeon.checkpoint){
    const clearedWave=dungeon.wave;
    for(const p of active){if(p.alive)p.hp=Math.min(100,p.hp+15);awardWave(p,clearedWave);}
    if(clearedWave%3===0){
      dungeon.checkpoint=true;
      dungeon.bullets=[];
      dungeon.pickups=[];
      for(const p of active)send(p.ws,{type:'checkpoint_ready',wave:clearedWave});
    }else{
      dungeon.wave++;
      spawnWave();
      for(const p of active)send(p.ws,{type:'wave',wave:dungeon.wave});
    }
  }
},1000*SIM_DT);

setInterval(()=>{
  for(const p of players.values())send(p.ws,snapshotFor(p));
},SNAPSHOT_MS);

server.listen(PORT,'0.0.0.0',()=>console.log('Dungeon Blaster immersive lobby server running on port '+PORT));