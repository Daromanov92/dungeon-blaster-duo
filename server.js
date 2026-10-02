const http=require('http');
const fs=require('fs');
const path=require('path');
const WebSocket=require('ws');

const PORT=process.env.PORT||8080;
const W=960,H=540,SIM_DT=1/60,SNAPSHOT_MS=33;
let nextPlayerId=1,nextEnemyId=1;

const players=new Map();
const dungeon={wave:1,enemies:new Map(),bullets:[],pickups:[]};

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
const eachPlayer=fn=>{for(const p of players.values())fn(p);};
const broadcast=o=>{const s=JSON.stringify(o);eachPlayer(p=>{if(p.ws.readyState===WebSocket.OPEN)p.ws.send(s);});};
const dungeonPlayers=()=>[...players.values()].filter(p=>p.zone==='dungeon');

function lobbyPayload(){
  return {type:'lobby',players:[...players.values()].map(p=>({id:p.id,nick:p.nick,zone:p.zone}))};
}
function broadcastLobby(){broadcast(lobbyPayload());}

function spawnWave(){
  dungeon.enemies.clear();dungeon.bullets=[];dungeon.pickups=[];
  const count=Math.min(28,6+dungeon.wave*2);
  for(let i=0;i<count;i++){
    const side=Math.floor(Math.random()*4);let x,y;
    if(side===0){x=55;y=55+Math.random()*(H-110)}
    if(side===1){x=W-55;y=55+Math.random()*(H-110)}
    if(side===2){x=55+Math.random()*(W-110);y=55}
    if(side===3){x=55+Math.random()*(W-110);y=H-55}
    const hp=28+dungeon.wave*5;
    dungeon.enemies.set(nextEnemyId,{id:nextEnemyId++,x,y,hp,maxHp:hp,speed:44+dungeon.wave*1.5,type:Math.random()<.30?'shooter':'melee',shoot:.6+Math.random()*1.3});
  }
}
spawnWave();

function resetPlayerForDungeon(p){
  const offset=((p.id%7)-3)*24;
  p.x=W/2+offset;p.y=H/2+((p.id%2)?22:-22);
  p.hp=100;p.alive=true;p.ammo=8;p.reload=0;p.fireCd=0;p.dashCd=0;
  p.input={dx:0,dy:0,dash:false};
}
function damage(p,d){if(!p.alive)return;p.hp-=d;if(p.hp<=0){p.hp=0;p.alive=false;}}

function nearestAlive(e){
  let target=null,best=Infinity;
  for(const p of players.values()){
    if(p.zone!=='dungeon'||!p.alive)continue;
    const d=Math.hypot(p.x-e.x,p.y-e.y);
    if(d<best){best=d;target=p;}
  }
  return [target,best];
}

function snapshot(){
  return {
    type:'snapshot',wave:dungeon.wave,
    players:dungeonPlayers().map(p=>({id:p.id,nick:p.nick,x:p.x,y:p.y,hp:p.hp,alive:p.alive,ammo:p.ammo,reload:p.reload})),
    enemies:[...dungeon.enemies.values()].map(e=>({id:e.id,x:e.x,y:e.y,hp:e.hp,maxHp:e.maxHp,type:e.type})),
    bullets:dungeon.bullets.map(b=>({x:b.x,y:b.y,vx:b.vx,vy:b.vy,team:b.team})),
    pickups:dungeon.pickups
  };
}

wss.on('connection',ws=>{
  let p=null;
  ws.on('message',buf=>{
    let m;try{m=JSON.parse(buf.toString())}catch{return;}

    if(m.type==='join'){
      if(p)return;
      const nick=String(m.nick||'Player').trim().slice(0,16)||'Player';
      p={id:nextPlayerId++,nick,ws,zone:'lobby',x:W/2,y:H/2,hp:100,alive:true,ammo:8,reload:0,fireCd:0,dashCd:0,input:{dx:0,dy:0,dash:false}};
      players.set(p.id,p);
      send(ws,{type:'joined',id:p.id});
      send(ws,lobbyPayload());
      broadcastLobby();
      return;
    }
    if(!p)return;

    if(m.type==='enter_dungeon'){
      if(p.zone!=='dungeon'){
        p.zone='dungeon';resetPlayerForDungeon(p);
        send(ws,{type:'entered_dungeon',wave:dungeon.wave});
        broadcastLobby();
      }
      return;
    }
    if(m.type==='leave_dungeon'){
      p.zone='lobby';p.input={dx:0,dy:0,dash:false};broadcastLobby();send(ws,{type:'back_to_lobby'});return;
    }

    if(m.type==='input'&&p.zone==='dungeon'&&p.alive){
      let dx=Number(m.dx)||0,dy=Number(m.dy)||0;
      const l=Math.hypot(dx,dy);
      if(l>1){dx/=l;dy/=l;}
      p.input={dx,dy,dash:!!m.dash};
      return;
    }
    if(m.type==='shoot'&&p.zone==='dungeon'&&p.alive&&p.fireCd<=0&&p.reload<=0){
      if(p.ammo<=0){p.reload=.72;return;}
      let dx=Number(m.dx)||0,dy=Number(m.dy)||0;
      const l=Math.hypot(dx,dy)||1;dx/=l;dy/=l;
      p.ammo--;p.fireCd=.15;
      dungeon.bullets.push({x:p.x,y:p.y,vx:dx*900,vy:dy*900,life:1.15,team:'p',owner:p.id,dmg:15});
      return;
    }
    if(m.type==='reload'&&p.zone==='dungeon'&&p.reload<=0&&p.ammo<8)p.reload=.72;
    if(m.type==='respawn'&&p.zone==='dungeon'&&!p.alive){p.hp=60;p.alive=true;p.x=W/2;p.y=H/2;}
  });

  ws.on('close',()=>{
    if(!p)return;
    players.delete(p.id);
    broadcastLobby();
  });
});

setInterval(()=>{
  const active=dungeonPlayers();

  for(const p of active){
    p.fireCd=Math.max(0,p.fireCd-SIM_DT);
    p.dashCd=Math.max(0,p.dashCd-SIM_DT);
    if(p.reload>0){p.reload-=SIM_DT;if(p.reload<=0)p.ammo=8;}
    if(!p.alive)continue;

    let speed=195;
    if(p.input.dash&&p.dashCd<=0){speed=440;p.dashCd=1.05;}
    p.x=Math.max(32,Math.min(W-32,p.x+p.input.dx*speed*SIM_DT));
    p.y=Math.max(32,Math.min(H-32,p.y+p.input.dy*speed*SIM_DT));
  }

  if(active.length===0)return;

  for(const e of dungeon.enemies.values()){
    const [t,d]=nearestAlive(e);if(!t)continue;
    const dx=t.x-e.x,dy=t.y-e.y,l=Math.hypot(dx,dy)||1,nx=dx/l,ny=dy/l;
    if(e.type==='melee'){
      if(d>25){e.x+=nx*e.speed*SIM_DT;e.y+=ny*e.speed*SIM_DT;}else damage(t,18*SIM_DT);
    }else{
      if(d>190){e.x+=nx*e.speed*.65*SIM_DT;e.y+=ny*e.speed*.65*SIM_DT;}
      if(d<135){e.x-=nx*e.speed*.55*SIM_DT;e.y-=ny*e.speed*.55*SIM_DT;}
      e.shoot-=SIM_DT;
      if(e.shoot<=0&&d<370){
        dungeon.bullets.push({x:e.x,y:e.y,vx:nx*320,vy:ny*320,life:2,team:'e',owner:e.id,dmg:10});
        e.shoot=1+Math.random()*.9;
      }
    }
  }

  for(const b of dungeon.bullets){
    b.x+=b.vx*SIM_DT;b.y+=b.vy*SIM_DT;b.life-=SIM_DT;
    if(b.x<24||b.x>W-24||b.y<24||b.y>H-24)b.life=0;
    if(b.team==='p'){
      for(const e of dungeon.enemies.values()){
        if(Math.hypot(b.x-e.x,b.y-e.y)<15){
          e.hp-=b.dmg;b.life=0;
          if(e.hp<=0){
            dungeon.enemies.delete(e.id);
            if(Math.random()<.40)dungeon.pickups.push({x:e.x,y:e.y,type:Math.random()<.55?'ammo':'heal'});
          }
          break;
        }
      }
    }else{
      for(const p of active){
        if(p.alive&&Math.hypot(b.x-p.x,b.y-p.y)<15){damage(p,b.dmg);b.life=0;break;}
      }
    }
  }
  dungeon.bullets=dungeon.bullets.filter(b=>b.life>0);

  for(let i=dungeon.pickups.length-1;i>=0;i--){
    const pk=dungeon.pickups[i];let taken=false;
    for(const p of active){
      if(p.alive&&Math.hypot(pk.x-p.x,pk.y-p.y)<22){
        if(pk.type==='heal')p.hp=Math.min(100,p.hp+25);else p.ammo=Math.min(8,p.ammo+3);
        taken=true;break;
      }
    }
    if(taken)dungeon.pickups.splice(i,1);
  }

  if(dungeon.enemies.size===0){
    dungeon.wave++;
    for(const p of active){if(p.alive)p.hp=Math.min(100,p.hp+12);}
    spawnWave();
    broadcast({type:'wave',wave:dungeon.wave});
  }
},1000*SIM_DT);

setInterval(()=>{
  if(dungeonPlayers().length===0)return;
  const s=JSON.stringify(snapshot());
  for(const p of players.values())if(p.zone==='dungeon'&&p.ws.readyState===WebSocket.OPEN)p.ws.send(s);
},SNAPSHOT_MS);

server.listen(PORT,'0.0.0.0',()=>console.log('Dungeon Blaster lobby server running on port '+PORT));