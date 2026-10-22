const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));

// Rounded-rectangle distance and its outward normal produce a lens only at the
// bevel. The neutral center leaves background geometry undistorted.
export function displacementField(width,height,radius,bevel=22,maxSide=640){
  width=clamp(Number(width)||1,1,4096);height=clamp(Number(height)||1,1,4096);
  radius=clamp(Number(radius)||0,0,Math.min(width,height)/2);
  const ratio=Math.min(1,maxSide/Math.max(width,height));
  const columns=Math.max(1,Math.ceil(width*ratio)),rows=Math.max(1,Math.ceil(height*ratio));
  const data=new Uint8ClampedArray(columns*rows*4);
  const band=clamp(bevel,2,Math.min(width,height)/2);
  for(let row=0;row<rows;row++)for(let column=0;column<columns;column++){
    const x=(column+.5)*width/columns-width/2,y=(row+.5)*height/rows-height/2;
    const qx=Math.abs(x)-(width/2-radius),qy=Math.abs(y)-(height/2-radius);
    const ax=Math.max(qx,0),ay=Math.max(qy,0),length=Math.hypot(ax,ay);
    const distance=length+Math.min(Math.max(qx,qy),0)-radius;
    let nx=0,ny=0,amount=0;
    if(distance<=0&&distance>-band){
      if(length>0){nx=ax/length*Math.sign(x);ny=ay/length*Math.sign(y);}
      else if(qx>qy)nx=Math.sign(x);else ny=Math.sign(y);
      amount=Math.sin((1+distance/band)*Math.PI/2)**2;
    }
    const offset=(row*columns+column)*4;
    data[offset]=128-Math.round(nx*127*amount);
    data[offset+1]=128-Math.round(ny*127*amount);
    data[offset+2]=Math.round(amount*255);data[offset+3]=255;
  }
  return {width:columns,height:rows,data};
}
