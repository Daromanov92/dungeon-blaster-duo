const http=require('http');
const fs=require('fs');
const path=require('path');
const WebSocket=require('ws');

const PORT=process.env.PORT||8080;
const W=960,H=540,TICK=1/20,SNAPSHOT_EVERY=2;
let nextPlayerId=1,nextEnemyId=1,tickNo=0;
const players=new Map(), enemies=new Map(), bullets=[], pickups=[];

function serve(req,res){
  let u=req.url.split('?')[0]; if(u==='/')u='/index.html';
  const f=path.join(__dirname,'public',u);
  fs.readFile(f,(err,data)=>{
    if(err){res.writeHead(404);res.end('Not found');return;}
    const ext=path.extname(f);
    const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
    res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream'});
    res.end(data);
  });
}
const server=http.createServer(serve);
const wss=new WebSocket.Server({server});

const send=(ws,o)=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(o));};
function broadcast(o){
  const s=JSON.stringify(o);
  for(const p of players.values()) if(p.ws.readyState===WebSocket.OPEN) p.ws.send(s);
}
function lobbyList(){return [...players.values()].map(p=>({id:p.id,nick:p.nick,zone:p.zone}));}

function spawnEnemies(target=10){
  while(enemies.size<target){
    const side=Math.floor(Math.random()*4); let x,y;
    if(side===0){x=70;y=70+Math.random()*(H-140)}
    if(side===1){x=W-70;y=70+Math.random()*(H-140)}
    if(side===2){x=70+Math.random()*(W-140);y=70}
    if(side===3){x=70+Math.random()*(W-140);y=H-70}
    const hp=36;
    enemies.set(nextEnemyId,{id:nextEnemyId++,x,y,hp,maxHp:hp,speed:52,type:Math.random()<.3?'shooter':'melee',shoot:.8+Math.random()*1.2});
  }
}
spawnEnemies();

function dungeonPlayers(){return [...players.values()].filter(p=>p.zone==='dungeon'&&p.alive);}
function nearest(e){
  let t=null,bd=1e9;
  for(const p of dungeonPlayers()){const d=Math.hypot(p.x-e.x,p.y-e.y);if(d<bd){bd=d;t=p;}}
  return [t,bd];
}
function damage(p,d){if(!p.alive)return;p.hp-=d;if(p.hp<=0){p.hp=0;p.alive=false;}}
function snap(){
  return {
    type:'snapshot',
    players:lobbyList().map(x=>{
      const p=players.get(x.id);
      return {id:p.id,nick:p.nick,zone:p.zone,x:p.x,y:p.y,hp:p.hp,alive:p.alive,ammo:p.ammo,reload:p.reload};
    }),
    enemies:[...enemies.values()].map(e=>({id:e.id,x:e.x,y:e.y,hp:e.hp,maxHp:e.maxHp,type:e.type})),
    bullets:bullets.map(b=>({x:b.x,y:b.y,team:b.team})),
    pickups
  };
}

wss.on('connection',ws=>{
  let player=null;

  ws.on('message',buf=>{
    let m;try{m=JSON.parse(buf.toString())}catch{return;}

    if(m.type==='join'){
      if(player)return;
      const nick=String(m.nick||'Player').trim().slice(0,16)||'Player';
      player={id:nextPlayerId++,nick,ws,zone:'lobby',x:W/2,y:H/2,hp:100,alive:true,ammo:8,reload:0,fireCd:0,dashCd:0};
      players.set(player.id,player);
      send(ws,{type:'joined',id:player.id});
      broadcast({type:'lobby',players:lobbyList()});
      return;
    }
    if(!player)return;

    if(m.type==='enter_dungeon'){
      player.zone='dungeon';player.x=W/2;player.y=H/2;player.hp=100;player.alive=true;player.ammo=8;
      spawnEnemies(10);
      broadcast({type:'lobby',players:lobbyList()});
      send(ws,{type:'entered_dungeon'});
      return;
    }

    if(m.type==='input'&&player.zone==='dungeon'&&player.alive){
      let dx=Number(m.dx)||0,dy=Number(m.dy)||0;const l=Math.hypot(dx,dy)||1;dx/=l;dy/=l;
      let speed=190;if(m.dash&&player.dashCd<=0){speed=430;player.dashCd=1.15;}
      player.x=Math.max(32,Math.min(W-32,player.x+dx*speed*TICK));
      player.y=Math.max(32,Math.min(H-32,player.y+dy*speed*TICK));
    }

    if(m.type==='shoot'&&player.zone==='dungeon'&&player.alive&&player.fireCd<=0&&player.reload<=0){
      if(player.ammo<=0){player.reload=.75;return;}
      let dx=Number(m.dx)||0,dy=Number(m.dy)||0;const l=Math.hypot(dx,dy)||1;dx/=l;dy/=l;
      player.ammo--;player.fireCd=.16;
      bullets.push({x:player.x,y:player.y,vx:dx*520,vy:dy*520,life:1.15,team:'p',owner:player.id,dmg:14});
    }
    if(m.type==='reload'&&player.reload<=0&&player.ammo<8)player.reload=.75;
  });

  ws.on('close',()=>{
    if(!player)return;
    players.delete(player.id);
    broadcast({type:'lobby',players:lobbyList()});
  });
});

setInterval(()=>{
  tickNo++;

  for(const p of players.values()){
    p.fireCd=Math.max(0,p.fireCd-TICK);
    p.dashCd=Math.max(0,p.dashCd-TICK);
    if(p.reload>0){p.reload-=TICK;if(p.reload<=0)p.ammo=8;}
  }

  const active=dungeonPlayers();
  if(active.length){
    for(const e of enemies.values()){
      const [t,d]=nearest(e); if(!t)break;
      const dx=t.x-e.x,dy=t.y-e.y,l=Math.hypot(dx,dy)||1,nx=dx/l,ny=dy/l;
      if(e.type==='melee'){
        if(d>25){e.x+=nx*e.speed*TICK;e.y+=ny*e.speed*TICK;}else damage(t,20*TICK);
      }else{
        if(d>200){e.x+=nx*e.speed*.65*TICK;e.y+=ny*e.speed*.65*TICK;}
        if(d<140){e.x-=nx*e.speed*.55*TICK;e.y-=ny*e.speed*.55*TICK;}
        e.shoot-=TICK;
        if(e.shoot<=0&&d<380){
          bullets.push({x:e.x,y:e.y,vx:nx*240,vy:ny*240,life:2,team:'e',dmg:10});
          e.shoot=1+Math.random()*1.1;
        }
      }
    }
  }

  for(const b of bullets){
    b.x+=b.vx*TICK;b.y+=b.vy*TICK;b.life-=TICK;
    if(b.x<24||b.x>W-24||b.y<24||b.y>H-24)b.life=0;
    if(b.team==='p'){
      for(const e of enemies.values()){
        if(Math.hypot(b.x-e.x,b.y-e.y)<15){
          e.hp-=b.dmg;b.life=0;
          if(e.hp<=0){enemies.delete(e.id);if(Math.random()<.4)pickups.push({x:e.x,y:e.y,type:Math.random()<.55?'ammo':'heal'});}
          break;
        }
      }
    }else{
      for(const p of active){
        if(Math.hypot(b.x-p.x,b.y-p.y)<15){damage(p,b.dmg);b.life=0;break;}
      }
    }
  }
  for(let i=bullets.length-1;i>=0;i--)if(bullets[i].life<=0)bullets.splice(i,1);

  for(let i=pickups.length-1;i>=0;i--){
    const pk=pickups[i];let taken=false;
    for(const p of active){
      if(Math.hypot(pk.x-p.x,pk.y-p.y)<22){
        if(pk.type==='heal')p.hp=Math.min(100,p.hp+25);else p.ammo=Math.min(8,p.ammo+3);
        taken=true;break;
      }
    }
    if(taken)pickups.splice(i,1);
  }

  if(enemies.size<6)spawnEnemies(10);
  if(tickNo%SNAPSHOT_EVERY===0)broadcast(snap());
},1000*TICK);

server.listen(PORT,'0.0.0.0',()=>console.log('Dungeon Blaster Duo running on port '+PORT));