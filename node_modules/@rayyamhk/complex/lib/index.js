"use strict";

function _typeof(obj) { "@babel/helpers - typeof"; if (typeof Symbol === "function" && typeof Symbol.iterator === "symbol") { _typeof = function _typeof(obj) { return typeof obj; }; } else { _typeof = function _typeof(obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; }; } return _typeof(obj); }

/**
 * Returns a Complex Number
 * @param { Number } arg1 - real part of the complex number
 * @param { Number } arg2 - imaginary part of the complex number
 * @return { Complex } - Complex Number
 */
function Complex(arg1, arg2) {
  var type1 = _typeof(arg1);

  var type2 = _typeof(arg2);

  if (type1 === 'number' && type2 === 'undefined') {
    if (Number.isNaN(arg1) || !Number.isFinite(arg1)) {
      this.re = NaN;
      this.im = NaN;
      return this;
    }

    this.re = arg1;
    this.im = 0;
    return this;
  }

  if (type1 === 'number' && type2 === 'number') {
    if (Number.isNaN(arg1) || Number.isNaN(arg2) || !Number.isFinite(arg1) || !Number.isFinite(arg2)) {
      this.re = NaN;
      this.im = NaN;
      return this;
    }

    this.re = arg1;
    this.im = arg2;
    return this;
  }

  this.re = NaN;
  this.im = NaN;
  return this;
}

Complex.prototype.getReal = require('./core/getReal');
Complex.prototype.getImaginary = require('./core/getImaginary');
Complex.prototype.getModulus = require('./core/getModulus');
Complex.prototype.getArgument = require('./core/getArgument');
Complex.prototype.toString = require('./core/toString');
Complex.isNaN = require('./core/isNaN');
Complex.isEqual = require('./core/isEqual');
Complex.conjugate = require('./core/conjugate');
Complex.inverse = require('./core/inverse');
Complex.add = require('./core/add');
Complex.subtract = require('./core/subtract');
Complex.multiply = require('./core/multiply');
Complex.divide = require('./core/divide');
Complex.exp = require('./core/exp');
Complex.log = require('./core/log');
Complex.pow = require('./core/pow');
Complex.sin = require('./core/sin');
Complex.cos = require('./core/cos');
Complex.tan = require('./core/tan');
Complex.csc = require('./core/csc');
Complex.sec = require('./core/sec');
Complex.cot = require('./core/cot');
Complex.asin = require('./core/asin');
Complex.acos = require('./core/acos');
Complex.atan = require('./core/atan');
Complex.acsc = require('./core/acsc');
Complex.asec = require('./core/asec');
Complex.acot = require('./core/acot');
Complex.NaN = new Complex(NaN);
Complex.ONE = new Complex(1);
Complex.ZERO = new Complex(0);
Complex.PI = new Complex(Math.PI);
Complex.E = new Complex(Math.E);
Complex.EPSILON = 1 / (Math.pow(10, 15) * 2);
module.exports = Complex;