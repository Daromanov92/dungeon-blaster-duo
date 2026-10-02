const http=require('http');
const fs=require('fs');
const path=require('path');
const WebSocket=require('ws');

const PORT=process.env.PORT||8080;
const W=960,H=540,DT=1/30;
const rooms=new Map();
let nextPlayerId=1,nextRoomId=1;

const server=http.createServer((req,res)=>{
  let u=req.url.split('?')[0];
  if(u==='/')u='/index.html';
  const f=path.join(__dirname,'public',u);
  fs.readFile(f,(err,data)=>{
    if(err){res.writeHead(404);res.end('Not found');return;}
    const ext=path.extname(f);
    const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
    res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream'});
    res.end(data);
  });
});

const wss=new WebSocket.Server({server});
const send=(ws,o)=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(o));};
const broadcast=(room,o)=>{const s=JSON.stringify(o);for(const p of room.players.values())if(p.ws.readyState===WebSocket.OPEN)p.ws.send(s);};

function waitingRoom(){
  for(const r of rooms.values())if(r.state==='waiting'&&r.players.size<2)return r;
  const r={id:String(nextRoomId++),state:'waiting',players:new Map(),enemies:new Map(),bullets:[],pickups:[],wave:1,nextEnemyId:1};
  rooms.set(r.id,r);return r;
}
function spawnWave(room){
  room.enemies.clear();room.bullets=[];room.pickups=[];
  const count=4+room.wave*2;
  for(let i=0;i<count;i++){
    const side=Math.floor(Math.random()*4);let x,y;
    if(side===0){x=60;y=60+Math.random()*(H-120)}
    if(side===1){x=W-60;y=60+Math.random()*(H-120)}
    if(side===2){x=60+Math.random()*(W-120);y=60}
    if(side===3){x=60+Math.random()*(W-120);y=H-60}
    const hp=28+room.wave*6;
    room.enemies.set(room.nextEnemyId,{id:room.nextEnemyId++,x,y,hp,maxHp:hp,speed:42+room.wave*2,type:Math.random()<.3?'shooter':'melee',shoot:.6+Math.random()*1.1});
  }
}
function start(room){
  room.state='playing';room.wave=1;let i=0;
  for(const p of room.players.values()){p.x=W/2+(i++?45:-45);p.y=H/2;p.hp=100;p.alive=true;p.ammo=8;p.reload=0;p.fireCd=0;p.dashCd=0;}
  spawnWave(room);broadcast(room,{type:'game_start',roomId:room.id});
}
function nearest(room,e){
  let t=null,bd=1e9;
  for(const p of room.players.values()){if(!p.alive)continue;const d=Math.hypot(p.x-e.x,p.y-e.y);if(d<bd){bd=d;t=p;}}
  return [t,bd];
}
function damage(p,d){if(!p.alive)return;p.hp-=d;if(p.hp<=0){p.hp=0;p.alive=false;}}
function snapshot(room){
  return {type:'snapshot',state:room.state,wave:room.wave,
    players:[...room.players.values()].map(p=>({id:p.id,nick:p.nick,x:p.x,y:p.y,hp:p.hp,alive:p.alive,ammo:p.ammo,reload:p.reload})),
    enemies:[...room.enemies.values()],bullets:room.bullets.map(b=>({x:b.x,y:b.y,team:b.team})),pickups:room.pickups};
}

wss.on('connection',ws=>{
  let player=null,room=null;
  ws.on('message',buf=>{
    let m;try{m=JSON.parse(buf.toString())}catch{return;}
    if(m.type==='join'){
      if(player)return;
      const nick=String(m.nick||'Player').trim().slice(0,16)||'Player';
      room=waitingRoom();
      player={id:nextPlayerId++,nick,ws,x:W/2,y:H/2,hp:100,alive:true,ammo:8,reload:0,fireCd:0,dashCd:0};
      room.players.set(player.id,player);
      send(ws,{type:'joined',id:player.id,roomId:room.id});
      broadcast(room,{type:'lobby',players:[...room.players.values()].map(p=>({id:p.id,nick:p.nick}))});
      if(room.players.size===2)start(room);
      return;
    }
    if(!player||!room)return;

    if(m.type==='input'&&room.state==='playing'&&player.alive){
      let dx=Number(m.dx)||0,dy=Number(m.dy)||0;const l=Math.hypot(dx,dy)||1;dx/=l;dy/=l;
      let speed=190;if(m.dash&&player.dashCd<=0){speed=430;player.dashCd=1.2;}
      player.x=Math.max(32,Math.min(W-32,player.x+dx*speed*DT));
      player.y=Math.max(32,Math.min(H-32,player.y+dy*speed*DT));
    }
    if(m.type==='shoot'&&room.state==='playing'&&player.alive&&player.fireCd<=0&&player.reload<=0){
      if(player.ammo<=0){player.reload=.8;return;}
      let dx=Number(m.dx)||0,dy=Number(m.dy)||0;const l=Math.hypot(dx,dy)||1;dx/=l;dy/=l;
      player.ammo--;player.fireCd=.16;
      room.bullets.push({x:player.x,y:player.y,vx:dx*520,vy:dy*520,life:1.2,team:'p',owner:player.id,dmg:14});
    }
    if(m.type==='reload'&&player.reload<=0&&player.ammo<8)player.reload=.8;
    if(m.type==='restart'&&room.state==='gameover'&&room.players.size===2)start(room);
  });
  ws.on('close',()=>{
    if(!player||!room)return;
    room.players.delete(player.id);
    if(room.players.size===0){rooms.delete(room.id);return;}
    room.state='waiting';room.enemies.clear();room.bullets=[];room.pickups=[];
    broadcast(room,{type:'partner_left'});
    broadcast(room,{type:'lobby',players:[...room.players.values()].map(p=>({id:p.id,nick:p.nick}))});
  });
});

setInterval(()=>{
  for(const room of rooms.values()){
    if(room.state!=='playing')continue;

    for(const p of room.players.values()){
      p.fireCd=Math.max(0,p.fireCd-DT);p.dashCd=Math.max(0,p.dashCd-DT);
      if(p.reload>0){p.reload-=DT;if(p.reload<=0)p.ammo=8;}
    }

    for(const e of room.enemies.values()){
      const [t,d]=nearest(room,e);if(!t)continue;
      const dx=t.x-e.x,dy=t.y-e.y,l=Math.hypot(dx,dy)||1,nx=dx/l,ny=dy/l;
      if(e.type==='melee'){
        if(d>25){e.x+=nx*e.speed*DT;e.y+=ny*e.speed*DT;}else damage(t,18*DT);
      }else{
        if(d>190){e.x+=nx*e.speed*.65*DT;e.y+=ny*e.speed*.65*DT;}
        if(d<135){e.x-=nx*e.speed*.55*DT;e.y-=ny*e.speed*.55*DT;}
        e.shoot-=DT;
        if(e.shoot<=0&&d<360){room.bullets.push({x:e.x,y:e.y,vx:nx*240,vy:ny*240,life:2,team:'e',owner:e.id,dmg:10});e.shoot=.9+Math.random()*.9;}
      }
    }

    for(const b of room.bullets){
      b.x+=b.vx*DT;b.y+=b.vy*DT;b.life-=DT;
      if(b.x<24||b.x>W-24||b.y<24||b.y>H-24)b.life=0;
      if(b.team==='p'){
        for(const e of room.enemies.values()){
          if(Math.hypot(b.x-e.x,b.y-e.y)<15){
            e.hp-=b.dmg;b.life=0;
            if(e.hp<=0){room.enemies.delete(e.id);if(Math.random()<.45)room.pickups.push({x:e.x,y:e.y,type:Math.random()<.55?'ammo':'heal'});}
            break;
          }
        }
      }else{
        for(const p of room.players.values())if(p.alive&&Math.hypot(b.x-p.x,b.y-p.y)<15){damage(p,b.dmg);b.life=0;break;}
      }
    }
    room.bullets=room.bullets.filter(b=>b.life>0);

    for(let i=room.pickups.length-1;i>=0;i--){
      const pk=room.pickups[i];let taken=false;
      for(const p of room.players.values()){
        if(p.alive&&Math.hypot(pk.x-p.x,pk.y-p.y)<22){
          if(pk.type==='heal')p.hp=Math.min(100,p.hp+25);else p.ammo=Math.min(8,p.ammo+3);
          taken=true;break;
        }
      }
      if(taken)room.pickups.splice(i,1);
    }

    const ps=[...room.players.values()];
    if(ps.length===2&&ps.every(p=>!p.alive)){room.state='gameover';broadcast(room,{type:'gameover'});}
    else if(room.enemies.size===0){
      room.wave++;
      for(const p of ps){if(p.alive)p.hp=Math.min(100,p.hp+15);else{p.alive=true;p.hp=50;}}
      spawnWave(room);broadcast(room,{type:'wave',wave:room.wave});
    }
    broadcast(room,snapshot(room));
  }
},1000/30);

server.listen(PORT,'0.0.0.0',()=>console.log('Dungeon Blaster Duo running on port '+PORT));